---
title: Architecture
description: How presence flows from agent hooks to your signature.
---

```text
Codex / Claude Code / Gemini CLI / opencode / Pi / Grok hooks
-> hook records an event in the local queue and returns
-> worker applies queued events to locked JSON state (TTL pruning)
-> usage refresh + debounced renderer (templates + usage badges)
-> l.garyyang slot  (value storage; magic-builder FaaS fronts it for the preview)
-> Feishu signature link preview
```

The pipeline is event-driven: a hook records its event in a local queue and returns. A worker applies queued events to JSON state under the state lock, refreshes usage on session boundaries and publishes through the debounced renderer. It exits after five idle minutes.

Token usage is read **after the fact** from local agent transcripts. The managed dsh plugin is the exception: its hook payload carries each model call's usage, which the worker appends to a local log for the usage scanner to read.

`setup` uses the kit harness to plan changes, request confirmation before writing agent configuration, record artifacts in a ledger and verify them; `uninstall` removes those recorded artifacts. `doctor` checks installation health; `inventory` shows the shared ledger. See [Install](/guide/install/#installed-locations) for managed locations.

## Providers

CLI commands resolve a provider through a small registry (`createProvider`) and assert only the capability they need — login, publish, or signature URL — so they never depend on a concrete backend. The shared remote value store is modelled as a `SlotBackend`: both `magic-builder` (default) and `feishu-signature` compose the same backend for login/publish/info and differ only in which preview URL Feishu embeds. Neither provider depends on the other, and a future provider with its own storage can implement the interface without touching the slot backend.

For the full design and trust boundaries, see `docs/architecture.md` in the repository.

## Sources

Which agents feed presence is a **source table**. Seven built-ins ship as a default table (each referencing an in-code resolver via a `builtin:<id>` handler); a user's `plugins.sources` in config merges over it by id — a same-id entry overrides a built-in, a new id adds a source, and `enabled: false` disables one. A source resolves via `builtin:<id>` (trusted, raw environment), a no-code declarative `match` spec, or a JS `handler` module. `agent-presence source add` installs a source-plugin npm package into an isolated plugins dir and registers it; handlers run in-process under guardrails (credential-stripped environment, path/config ownership checks) and fail open, so a source can never block a hook. See the [Sources guide](/guide/sources/).
