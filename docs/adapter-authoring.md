# Adapter contract

The alpha exports its provider boundary from `@relay-ai/cli/adapter-contract`. An adapter reports
capabilities, starts and optionally resumes a run, streams normalized events, and cancels by Relay run ID.

Adapters must:

- accept explicit cwd, model, permission mode, prompt, time/output limits, and cancellation signal;
- return process/session metadata and paths to already-redacted stdout/stderr;
- retain raw event objects inside normalized events so new fields are not lost;
- avoid reading or copying provider credential stores;
- use argument-vector spawning without a shell;
- treat provider success prose as informational rather than authoritative.

Arbitrary third-party adapter loading is intentionally out of scope for v0.1. The export stabilizes the
handoff boundary and supports fixture authors without creating a plugin execution surface yet.
