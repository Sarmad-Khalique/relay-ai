# Contributing to ProvenWay

Thank you for helping make local AI coding workflows safer and easier to inspect.

## Before opening a change

For bugs, include the ProvenWay version, operating system, provider CLI versions, the terminal run status, and
a minimal reproduction. Remove proprietary source, prompts, usernames, home-directory paths, session IDs,
and tokens from diagnostics. Report security issues privately as described in `SECURITY.md`.

For behavior changes, open an issue first when the change affects a public schema, state transition,
permission boundary, authentication behavior, or CLI command. v0.1 deliberately supports one fixed
workflow and no additional provider transports.

## Development setup

```bash
corepack enable
pnpm install
pnpm generate
pnpm check
```

Tests must not invoke a real provider unless their file is under `tests/live` and protected by the matching
`PROVENWAY_LIVE_*` environment variable. Use temporary Git repositories and fake executables for normal tests.

## Pull requests

- Keep public schemas backward compatible or increment `schema_version` with a documented migration.
- Add fixture coverage for new provider event versions and preserve unknown fields.
- Test crash, cancellation, path, and permission behavior for any side-effectful change.
- Update documentation when command output, configuration, or trust boundaries change.
- Run `pnpm release:check` before requesting review.

By contributing, you agree that your contribution is licensed under Apache-2.0.
