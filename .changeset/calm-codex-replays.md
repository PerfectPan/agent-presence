---
"@rivus/agent-presence": patch
---

Prevent Codex Desktop subagent transcript replays from inflating token totals in `agent-presence usage` and the Feishu signature badge. Forked session replay prefixes are now excluded using the same event semantics as ccusage while genuine subagent usage remains counted.
