# Codex adapter

ProvenWay uses the official Codex CLI `exec` transport, not an API key or App Server.

Required capabilities are probed from the installed CLI: non-interactive execution, JSONL events,
`--output-schema`, `--output-last-message`, explicit model selection, a read-only sandbox, and login status.
Planning and review are fresh, ephemeral, read-only invocations. Unknown JSONL fields are retained and
ignored. Invalid final JSON gets one format-only correction attempt.

Authenticate with:

```bash
codex login
codex login status
```

ProvenWay removes API-key variables when pay-as-you-go is disabled and rejects a detected API-key login. It
never reads Codex credential files. See the official OpenAI documentation for
[authentication](https://developers.openai.com/codex/auth) and the
[CLI command reference](https://developers.openai.com/codex/cli/reference).
