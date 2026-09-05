# Provider compatibility

Relay records provider versions in each run manifest. This maintainer matrix documents release-level
validation without storing credentials or provider output.

| Date       | Platform                 | Codex CLI | Architect/reviewer | Cursor Agent       | Implementer  | Result |
| ---------- | ------------------------ | --------- | ------------------ | ------------------ | ------------ | ------ |
| 2026-09-05 | macOS, Apple Silicon     | 0.153.4   | `gpt-5.6-sol`      | 2026.09.02-c22c1a3 | `auto`       | Pass   |
| 2026-09-05 | Node 22 Debian container | Fixtures  | Fake adapter       | Fixtures           | Fake adapter | Pass   |

The live test created a temporary Git repository, completed planning, implementation, deterministic
verification, and review, and left the source checkout unchanged. Compatibility with other provider
versions is checked defensively through `relay doctor --deep` and version-labelled JSONL fixtures.
