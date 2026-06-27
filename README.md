# pi-pass-secrets

Pi Coding Agent extension that reads API keys from [GNU Password Store](https://www.passwordstore.org/) (`pass`) on startup and injects them into the session environment.

**Secrets are never exposed to the LLM.** All tool output (bash, read, grep, etc.) is scanned and any leaked secret values are replaced with `[REDACTED]`.

## Why pass?

- **Encryption at rest** — all secrets are GPG-encrypted on disk
- **Git-friendly** — `~/.password-store` is a git repo you can sync
- **No daemon** — stateless, no background process
- **Proven** — the standard Unix password manager since 2012

## How it works

1. On `session_start`, the extension reads configured pass paths and injects them into `process.env`
2. All subsequent tool calls (including bash) inherit the secrets
3. A global `tool_result` hook scans every tool output for known secret values and replaces matches with `[REDACTED]`
4. On `session_shutdown`, secrets are cleared from `process.env`

## Install

```bash
pi install git:github.com/okiess/pi-pass-secrets
```

Or locally during development:

```bash
pi install ~/workspace/versioned/pi-pass-secrets
```

## Setup

### 1. Store your API keys in pass

```bash
pass insert apikeys/openai
pass insert apikeys/anthropic
pass insert apikeys/opencode
```

### 2. Configure mappings

Add to `~/.pi/agent/settings.json`:

```json
{
  "pass-secrets": {
    "mappings": {
      "apikeys/openai": "OPENAI_API_KEY",
      "apikeys/anthropic": "ANTHROPIC_API_KEY",
      "apikeys/opencode": "OPENCODE_API_KEY"
    }
  }
}
```

### 3. Reference in provider config

Your providers/models should already use `$ENV_VAR` references:

```json
{
  "apiKey": "$OPENCODE_API_KEY"
}
```

No changes needed — the extension injects the env var before providers resolve it.

## Commands

| Command | Description |
|---------|-------------|
| `/pass-secrets status` | Show loaded keys (values masked: `sk-a...4670`) |
| `/pass-secrets reload` | Re-read all secrets from pass |
| `/pass-secrets help` | Show help |

## Security model

**What the agent can see:**
- Which env vars are loaded (e.g. `$OPENCODE_API_KEY loaded`)
- A masked preview (`sk-a...4670`)

**What the agent cannot see:**
- Plaintext secret values
- Secrets in any tool output (redacted globally)

**Known limitations:**
- Secrets shorter than 5 characters are not redacted (too many false positives)
- If a child process prints a secret, the bash output redaction catches it — but the child process itself has access to the env var (by design)
- Encoding transforms (base64, hex, reverse) bypass exact-match redaction

## License

MIT
