# Cursor adapter

ProvenWay resolves the configured executable, then `agent`, then `cursor-agent`. Required capabilities are
browser/account status, explicit model selection, print mode, `stream-json`, resume IDs, workspace
selection, and enabled sandboxing.

Authenticate with:

```bash
agent login
agent status --format json
agent models
```

Before each write turn ProvenWay backs up `.cursor/cli.json`, merges only additional deny permissions, runs the
provider, and restores the exact original bytes and mode. Denies cover the overlay itself, Git internals,
secret paths, configured forbidden paths, destructive/remote Git and shell operations, and web fetches.
Git remains authoritative for the final changed-path list.

See Cursor's official documentation for [installation](https://cursor.com/docs/cli/installation),
[parameters](https://cursor.com/docs/cli/reference/parameters),
[permissions](https://cursor.com/docs/cli/reference/permissions), and
[streaming output](https://cursor.com/docs/cli/reference/output-format).

The adapter has fixture-based coverage in this alpha. The complete live workflow was also verified on
September 5, 2026 with Cursor Agent 2026.09.02-c22c1a3 using account authentication. See the
[compatibility record](../compatibility.md).
