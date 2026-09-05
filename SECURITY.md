# Security Policy

## Reporting a vulnerability

Do not file a public issue for a vulnerability. Once the project has a GitHub remote, use its private
Security Advisory reporting flow. Until then, contact the repository owner privately and include only the
minimum reproduction needed; never attach provider credentials or proprietary run logs.

The maintainers will acknowledge a report, assess affected versions, and coordinate disclosure. No fixed
response-time SLA is promised during the public alpha.

## Security boundary

Relay coordinates official local CLIs that run as the current operating-system user. It is not a hardened
container boundary and cannot prove that a provider with host-level access made no changes outside the
managed worktree.

Relay does:

- invoke providers with argument arrays rather than an interpolated shell;
- keep architect and reviewer stages read-only;
- use an isolated, registered Git worktree for the writer;
- enable Cursor's sandbox and apply tightening-only deny rules;
- strip API-key and secret-like environment variables from child processes;
- deny network access when a supported host mechanism is available;
- validate provider artifacts against canonical schemas;
- recompute changes with Git and fail on forbidden paths;
- redact logs before persistence and use restrictive file modes;
- require explicit confirmation for writes and destructive cleanup.

Relay does not read, copy, refresh, proxy, or reinterpret provider credential files. It does not guarantee
perfect secret detection, prevent every side effect of a provider-native tool, or make untrusted repository
code safe to execute. Review proposed verification commands before confirming a run.

Supported security fixes apply to the latest alpha only until a stable release policy is published.
