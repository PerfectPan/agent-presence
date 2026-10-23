---
'@rivus/agent-presence': patch
---

Upgrade `@rivus/agent-kit` and `@rivus/agent-kit-collab` to 0.21.1 with Effect 4.0.5 (the kit's required exact Effect peer). No kit API change. The kit's hook host sniffing fix reaches this app: a Claude Code hook event is no longer misattributed to Cursor when only the environment carries `CURSOR_VERSION`, so such events now drive Claude Code presence instead of being skipped with "no presence source". The kit's 0.21.1 session summary, redaction, Codex event id and ACP fixes touch transcript surfaces this app does not read.
