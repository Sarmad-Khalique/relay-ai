# Relay

Relay is a local, subscription-first control plane for deterministic AI coding workflows.
Configure your preferred authenticated coding CLIs once, then run the same guarded workflow in any Git
repository:

```text
Codex plans → Cursor implements → Relay verifies → Codex reviews → Cursor repairs
```

Relay is an early public alpha. The provider processes run as your local user; Relay adds worktree
isolation, deny policies, deterministic verification, durable state, and an audit trail, but it is not a
hardened container sandbox.

## Why Relay?

- Reuse account-authenticated Codex and Cursor CLIs without copying or managing their credentials.
- Keep AI edits out of your current checkout and on a dedicated `relay/*` branch.
- Treat model output as an untrusted claim; Git and configured verification determine completion.
- Stop after two focused repair attempts instead of entering an unbounded agent loop.
- Retain redacted local evidence for every state change, provider invocation, diff, check, and review.

## Requirements

- Node.js 22 or newer
- Git with at least one commit in the target repository
- [Codex CLI](https://developers.openai.com/codex/cli/reference) authenticated with `codex login`
- [Cursor Agent CLI](https://cursor.com/docs/cli/installation) authenticated with `agent login`

Relay defaults to subscription/account authentication and removes `OPENAI_API_KEY` and `CURSOR_API_KEY`
from child environments. Pay-as-you-go fallback is disabled.

> The complete live provider workflow was verified on macOS with account-authenticated Codex CLI 0.153.4
> and Cursor Agent 2026.09.02-c22c1a3. See the [compatibility record](docs/compatibility.md).

## Install from source

```bash
git clone https://github.com/Sarmad-Khalique/relay-ai.git
cd relay-ai
corepack enable
pnpm install
pnpm build
pnpm link --global
relay --version
```

The package is prepared as `@relay-ai/cli@0.1.0-alpha.1`; the `relay-ai` npm organization must exist and be
controlled by the publisher before the first registry release.

## Quick start

```bash
relay init
relay doctor --deep
cd /path/to/a/clean/git/repository
relay run "Add passkey authentication"
```

Relay plans read-only, then shows the selected models, proposed branch, exact verification commands,
network enforcement, and permissions. A write-capable run requires an interactive confirmation. There is
no `--yes` bypass.

Successful output identifies the run, retained branch, verification result, review blockers, and artifact
directory. Relay commits accepted changes to the generated branch before removing its worktree; it never
merges, pushes, rebases, creates a PR, deploys, or publishes.

## Commands

| Command                               | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `relay init`                          | Select explicit models and write global configuration        |
| `relay doctor [--deep]`               | Check binaries, auth, models, Git, capabilities, and storage |
| `relay run <task>`                    | Run the fixed plan/implement/verify/review/repair workflow   |
| `relay plan <task>`                   | Produce a validated TaskPacket without invoking Cursor       |
| `relay status [run]`                  | Show one run or recent history                               |
| `relay logs <run> [--stage <name>]`   | Read persisted, redacted provider logs                       |
| `relay diff <run>`                    | Print Relay's authoritative diff artifact                    |
| `relay resume <run>`                  | Continue from a safe blocked/interrupted boundary            |
| `relay cancel <run>`                  | Signal the active Relay process and preserve state           |
| `relay clean <run> [--delete-branch]` | Confirm and remove managed worktree/branch targets           |
| `relay delete <run>`                  | Confirm and permanently delete a terminal run's artifacts    |
| `relay config explain`                | Show resolved values and their source                        |

`run` and `plan` accept `--architect-model`, `--implementer-model`, `--reviewer-model`,
`--repair-attempts 0..2`, and `--keep-worktree always|on_failure|never`.

## Configuration

Configuration precedence is built-in defaults, global config, repository config, then supported CLI
flags. The global file is `${XDG_CONFIG_HOME:-~/.config}/relay/config.yaml`; a repository may add
`.relay/config.yaml`.

```yaml
version: 1
providers:
  codex:
    executable: codex
  cursor:
    executable: auto
roles:
  architect:
    adapter: codex
    model: your-codex-model
    reasoning: high
  implementer:
    adapter: cursor
    model: your-cursor-model
  reviewer:
    adapter: codex
    model: your-codex-model
    reasoning: high
workflow:
  repair_attempts: 2
  require_clean_worktree: true
  keep_worktree: on_failure
  provider_timeout_seconds: 1800
  max_event_bytes: 1048576
  max_log_bytes: 104857600
verification:
  discover: true
  commands:
    - name: unit tests
      argv: [pnpm, test]
      timeout_seconds: 900
      required: true
policy:
  allow_payg: false
  network: deny
  forbidden_paths:
    - "**/.env*"
    - "**/*.pem"
    - "**/*.key"
    - ".git/**"
```

Repository configuration is untrusted. It may select role models, reduce limits, add forbidden paths, and
propose verification commands. It cannot replace executable paths, enable paid/network access, remove
denies, or loosen global limits.

## Local data and recovery

Relay stores its SQLite index, managed worktrees, and per-run artifacts under
`${XDG_DATA_HOME:-~/.local/share}/relay`. Directories are mode `0700`; logs and artifacts are mode `0600`.
Run transitions are appended before side effects. `relay resume` can safely rerun read-only planning,
verification, and review work, or continue a worktree that already has a diff. It refuses to silently
repeat an interrupted writer that left no changes.

See [Security](docs/security.md), [Codex provider notes](docs/providers/codex.md),
[Cursor provider notes](docs/providers/cursor.md), and [Contributing](CONTRIBUTING.md).

## Development

```bash
pnpm generate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:smoke
pnpm test:linux
```

Live provider smoke tests are opt-in and consume account allowance:

```bash
RELAY_LIVE_CODEX=1 \
RELAY_LIVE_CURSOR=1 \
RELAY_LIVE_CODEX_MODEL="your-codex-model" \
RELAY_LIVE_CURSOR_MODEL="your-cursor-model" \
pnpm test:live
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
