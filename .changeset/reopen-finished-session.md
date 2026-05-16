---
"@rivus/agent-presence": patch
---

Reopen a finished agent session when a new user prompt arrives with the same session id, while still ignoring late async heartbeats after stop events.
