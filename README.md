# ProvenWay

**Plan. Build. Prove.**

ProvenWay is a local-first orchestrator for verifiable AI coding workflows.
Configure your preferred authenticated coding CLIs once, then run the same guarded workflow in any Git
repository:

```text
Codex plans → Cursor implements → ProvenWay verifies → Codex reviews → Cursor repairs
```

ProvenWay is an early public alpha. The provider processes run as your local user; ProvenWay adds worktree
isolation, deny policies, deterministic verification, durable state, and an audit trail, but it is not a
hardened container sandbox.

## Why ProvenWay?

- Reuse account-authenticated Codex and Cursor CLIs without copying or managing their credentials.
- Keep AI edits out of your current checkout and on a dedicated `provenway/*` branch.
- Treat model output as an untrusted claim; Git and configured verification determine completion.
- Stop after two focused repair attempts instead of entering an unbounded agent loop.
- Retain redacted local evidence for every state change, provider invocation, diff, check, and review.

## Requirements

- Node.js 22 or newer
- Git with at least one commit in the target repository
- [Codex CLI](https://developers.openai.com/codex/cli/reference) authenticated with `codex login`
- [Cursor Agent CLI](https://cursor.com/docs/cli/installation) authenticated with `agent login`

ProvenWay defaults to subscription/account authentication and removes `OPENAI_API_KEY` and `CURSOR_API_KEY`
from child environments. Pay-as-you-go fallback is disabled.

> The complete live provider workflow was verified on macOS with account-authenticated Codex CLI 0.153.4
> and Cursor Agent 2026.09.02-c22c1a3. See the [compatibility record](docs/compatibility.md).

## Install from source

```bash
git clone https://github.com/ProvenWay/provenway.git
cd provenway
corepack enable
pnpm install
pnpm build
pnpm link --global
provenway --version
```

The package is prepared as `@provenway/cli@0.1.0-alpha.1`; the `provenway` npm organization must exist and be
controlled by the publisher before the first registry release.

## Quick start

```bash
provenway init
provenway doctor --deep
cd /path/to/a/clean/git/repository
provenway run "Add passkey authentication"
```

ProvenWay plans read-only, then shows the selected models, proposed branch, exact verification commands,
network enforcement, and permissions. A write-capable run requires an interactive confirmation. There is
no `--yes` bypass.

Successful output identifies the run, retained branch, verification result, review blockers, and artifact
directory. ProvenWay commits accepted changes to the generated branch before removing its worktree; it never
merges, pushes, rebases, creates a PR, deploys, or publishes.

## Commands

| Command                                   | Purpose                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `provenway init`                          | Select explicit models and write global configuration        |
| `provenway doctor [--deep]`               | Check binaries, auth, models, Git, capabilities, and storage |
| `provenway run <task>`                    | Run the fixed plan/implement/verify/review/repair workflow   |
| `provenway plan <task>`                   | Produce a validated TaskPacket without invoking Cursor       |
| `provenway status [run]`                  | Show one run or recent history                               |
| `provenway logs <run> [--stage <name>]`   | Read persisted, redacted provider logs                       |
| `provenway diff <run>`                    | Print ProvenWay's authoritative diff artifact                |
| `provenway resume <run>`                  | Continue from a safe blocked/interrupted boundary            |
| `provenway cancel <run>`                  | Signal the active ProvenWay process and preserve state       |
| `provenway clean <run> [--delete-branch]` | Confirm and remove managed worktree/branch targets           |
| `provenway delete <run>`                  | Confirm and permanently delete a terminal run's artifacts    |
| `provenway config explain`                | Show resolved values and their source                        |

`run` and `plan` accept `--architect-model`, `--implementer-model`, `--reviewer-model`,
`--repair-attempts 0..2`, and `--keep-worktree always|on_failure|never`.

## Configuration

Configuration precedence is built-in defaults, global config, repository config, then supported CLI
flags. The global file is `${XDG_CONFIG_HOME:-~/.config}/provenway/config.yaml`; a repository may add
`.provenway/config.yaml`.

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

ProvenWay stores its SQLite index, managed worktrees, and per-run artifacts under
`${XDG_DATA_HOME:-~/.local/share}/provenway`. Directories are mode `0700`; logs and artifacts are mode `0600`.
Run transitions are appended before side effects. `provenway resume` can safely rerun read-only planning,
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
PROVENWAY_LIVE_CODEX=1 \
PROVENWAY_LIVE_CURSOR=1 \
PROVENWAY_LIVE_CODEX_MODEL="your-codex-model" \
PROVENWAY_LIVE_CURSOR_MODEL="your-cursor-model" \
pnpm test:live
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
