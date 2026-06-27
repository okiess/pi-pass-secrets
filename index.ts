/**
 * pass-secrets — Pi extension that reads API keys from the GNU Password Store
 * ("pass") on startup and injects them into process.env.
 *
 * Secrets are NEVER exposed to the LLM: all tool output is scanned and redacted.
 *
 * ## Setup
 *
 * 1. Store your API keys in pass:
 *    pass insert apikeys/openai
 *    pass insert apikeys/anthropic
 *
 * 2. Configure mappings in ~/.pi/agent/settings.json:
 *    {
 *      "pass-secrets": {
 *        "mappings": {
 *          "apikeys/openai": "OPENAI_API_KEY",
 *          "apikeys/anthropic": "ANTHROPIC_API_KEY"
 *        }
 *      }
 *    }
 *
 * 3. Reference in provider/model config via $ENV_VAR syntax.
 *
 * ## Commands
 *
 * /pass-secrets reload  — re-read secrets from pass
 * /pass-secrets status  — show loaded keys (values redacted)
 * /pass-secrets help    — show this help
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────────────────────────────

interface PassSecretsConfig {
  /** Map of pass-path → env-var-name */
  mappings: Record<string, string>;
}

interface SettingsFile {
  "pass-secrets"?: PassSecretsConfig;
}

// ── Constants ─────────────────────────────────────────────────────────

const MIN_REDACT_LENGTH = 5; // shorter strings risk false positives
const SETTINGS_PATH = resolve(homedir(), ".pi/agent/settings.json");
const PASS_BIN = "pass";

// ── State ─────────────────────────────────────────────────────────────

/** env-var-name → plaintext secret (for redaction) */
const loadedSecrets = new Map<string, string>();

/** pass-path → env-var-name (for status display) */
const loadedPaths = new Map<string, string>();

/** env-var-name → original value before we overwrote it (restored on shutdown) */
const originalEnv = new Map<string, string | undefined>();

// ── Settings ──────────────────────────────────────────────────────────

function readConfig(): PassSecretsConfig {
  try {
    if (!existsSync(SETTINGS_PATH)) return { mappings: {} };
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as SettingsFile;
    return raw["pass-secrets"] ?? { mappings: {} };
  } catch {
    return { mappings: {} };
  }
}

// ── Pass wrapper ──────────────────────────────────────────────────────

function passShow(passPath: string): string {
  const stdout = execFileSync(PASS_BIN, ["show", passPath], {
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // pass outputs the password on the first line; strip trailing newline
  return stdout.split("\n")[0]?.trim() ?? "";
}

function hasPass(): boolean {
  try {
    execFileSync("which", [PASS_BIN], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── Redaction ─────────────────────────────────────────────────────────

function redact(text: string): string {
  if (loadedSecrets.size === 0) return text;
  let result = text;
  for (const [, secret] of loadedSecrets) {
    if (secret.length < MIN_REDACT_LENGTH) continue;
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

/** Recursively redact all string values in an object/array. */
function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactDeep(v);
    }
    return result as T;
  }
  return value;
}

// ── Load / Clear ──────────────────────────────────────────────────────

function loadSecrets(config: PassSecretsConfig, onError: (msg: string) => void): number {
  // Save original env values once, before we overwrite anything.
  // Do this BEFORE clearSecrets so reloads don't lose the originals.
  for (const [, envVar] of Object.entries(config.mappings)) {
    if (!originalEnv.has(envVar)) {
      originalEnv.set(envVar, process.env[envVar]);
    }
  }

  clearSecrets();
  let count = 0;

  for (const [passPath, envVar] of Object.entries(config.mappings)) {
    try {
      const secret = passShow(passPath);
      if (!secret) {
        onError(`empty secret at pass path: ${passPath}`);
        continue;
      }
      process.env[envVar] = secret;
      loadedSecrets.set(envVar, secret);
      loadedPaths.set(passPath, envVar);
      count++;
    } catch (err) {
      onError(`failed to read pass "${passPath}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return count;
}

function clearSecrets(): void {
  for (const [envVar] of loadedSecrets) {
    const original = originalEnv.get(envVar);
    if (original === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = original;
    }
  }
  loadedSecrets.clear();
  loadedPaths.clear();
  // Note: originalEnv is intentionally NOT cleared here —
  // it's only cleared on full session_shutdown so reloads work correctly.
}

function shutdown(): void {
  clearSecrets();
  originalEnv.clear();
}

// ── Extension ─────────────────────────────────────────────────────────

export default function passSecretsExtension(pi: ExtensionAPI) {
  const config = readConfig();

  if (!hasPass()) {
    // pass not installed — register no-op so it doesn't throw
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setStatus("pass", "pass: not installed");
    });
    return;
  }

  if (Object.keys(config.mappings).length === 0) {
    // No mappings configured — still register for when config is added
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setStatus("pass", "pass: no mappings configured");
    });
  }

  // ── Global redaction: intercept ALL tool results ─────────────────
  pi.on("tool_result", async (event) => {
    if (loadedSecrets.size === 0) return;

    let changed = false;
    const redacted = event.content.map((c) => {
      if (c.type !== "text") return c;
      const text = redact(c.text);
      if (text === c.text) return c;
      changed = true;
      return { ...c, text };
    });

    // Also redact details (recursively — covers bash output, stderr, etc.)
    let redactedDetails: typeof event.details | undefined;
    if (event.details) {
      redactedDetails = redactDeep(event.details);
    }
    const detailsChanged = redactedDetails !== event.details;

    if (!changed && !detailsChanged) return;
    const result: { content?: typeof redacted; details?: typeof redactedDetails } = {};
    if (changed) result.content = redacted;
    if (detailsChanged) result.details = redactedDetails;
    return result;
  });

  // ── Session lifecycle ───────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const currentConfig = readConfig();
    const count = loadSecrets(currentConfig, (msg) => {
      console.error(`[pass-secrets] ${msg}`);
    });

    if (count > 0) {
      ctx.ui.setStatus("pass", `pass: ${count} key(s)`);
      ctx.ui.notify(`Loaded ${count} API key(s) from pass`, "info");
    } else if (Object.keys(currentConfig.mappings).length > 0) {
      ctx.ui.setStatus("pass", "pass: load failed");
      ctx.ui.notify("pass: failed to load secrets — check settings", "error");
    } else {
      ctx.ui.setStatus("pass", "pass: no mappings");
    }
  });

  pi.on("session_shutdown", async () => {
    shutdown();
  });

  // ── /pass-secrets command ───────────────────────────────────────
  pi.registerCommand("pass-secrets", {
    description: "Manage secrets loaded from pass (reload | status | help)",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();

      if (sub === "reload" || sub === "r") {
        const currentConfig = readConfig();
        const count = loadSecrets(currentConfig, (msg) => {
          ctx.ui.notify(msg, "error");
        });
        ctx.ui.setStatus("pass", `pass: ${count} key(s)`);
        ctx.ui.notify(`Reloaded ${count} API key(s) from pass`, "info");
        return;
      }

      if (sub === "status" || sub === "s" || sub === "") {
        if (loadedPaths.size === 0) {
          ctx.ui.notify("pass: no secrets loaded", "info");
          return;
        }
        const lines: string[] = [];
        for (const [passPath, envVar] of loadedPaths) {
          const secret = loadedSecrets.get(envVar) ?? "";
          const preview = secret.length > 8
            ? `${secret.slice(0, 4)}...${secret.slice(-4)}`
            : "(short)";
          lines.push(`  pass show ${passPath} → $${envVar}=${preview}`);
        }
        ctx.ui.notify(`Loaded secrets:\n${lines.join("\n")}`, "info");
        return;
      }

      if (sub === "help" || sub === "h") {
        ctx.ui.notify(
          "pass-secrets commands:\n" +
          "  /pass-secrets reload  — re-read secrets from pass\n" +
          "  /pass-secrets status  — show loaded keys (values redacted)\n" +
          "  /pass-secrets help    — show this help\n\n" +
          "Configure mappings in ~/.pi/agent/settings.json:\n" +
          '  "pass-secrets": { "mappings": { "apikeys/openai": "OPENAI_API_KEY" } }',
          "info",
        );
        return;
      }

      ctx.ui.notify(`Unknown subcommand: "${args}". Try /pass-secrets help`, "error");
    },
  });
}
