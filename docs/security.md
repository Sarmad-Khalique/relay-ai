# ProvenWay threat model

ProvenWay assumes repository contents, repository configuration, model output, proposed commands, and provider
event streams may be malicious. Official provider binaries and their native sandboxes remain part of the
trusted computing base.

## Controls

1. Repository config cannot select executables, enable paid/network access, remove deny paths, or increase
   repair/time/output limits.
2. Codex planning and review use fresh ephemeral invocations with read-only sandboxing and schema-validated
   output.
3. Cursor writes only in a managed worktree, with its sandbox enabled and a temporary project deny overlay.
4. ProvenWay restores that overlay before evaluating the diff and on resume after a crash.
5. Verification uses exact argv without a shell. Discovered and configured commands are shown before the
   single write confirmation.
6. macOS verification uses `sandbox-exec` to deny network; Linux uses Bubblewrap when installed. ProvenWay
   visibly reports when host network enforcement is unavailable.
7. Required checks, Git state, forbidden paths, and structured review—not provider prose—determine
   acceptance.
8. A writer is never silently replayed after an interruption. A diff can advance to verification; no diff
   requires a new run.

The default forbidden set covers environment files, PEM/private-key files, and Git internals. Providers
also receive denies for destructive/remote shell commands and web fetches.

## Sensitive local data

Prompts, source excerpts, diffs, and logs can remain sensitive even after token redaction. ProvenWay stores them
locally with restrictive modes and telemetry is absent. Use `provenway delete <run>` when retention is no longer
appropriate.
