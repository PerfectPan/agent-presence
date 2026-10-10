---
'@rivus/agent-presence': minor
---

Add Grok as a built-in source. It appears in `agent-presence source list`, and hooks drive it through `agent-presence hook --source grok --event <presence event name>` (`--event SessionStart`, `--event Stop`, and so on): this release expects the caller to pass presence event names and does not normalize Grok's native snake_case hook names, so a payload carrying `stop` without `--event` is treated as a heartbeat. Installing Grok hooks comes with a later release step, and usage scanning for Grok is not wired yet.
