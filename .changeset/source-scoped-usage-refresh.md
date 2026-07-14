---
"@rivus/agent-presence": patch
---

Scope signature usage refreshes to the agent that emitted the session-boundary hook. Cache per-source contributions for aggregation, while keeping `agent-presence update` as the explicit full-refresh path, so an OpenCode event cannot rescan or overwrite Codex usage.
