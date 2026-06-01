---
'@rivus/agent-presence': minor
---

Add Pi Coding Agent (`@earendil-works/pi-coding-agent`) as a supported source. Setup installs a managed Pi extension at `~/.pi/agent/extensions/agent-presence.ts` that bridges Pi lifecycle events (`before_agent_start`, `turn_start`, `tool_execution_*`, `agent_end`, `session_shutdown`) into the existing presence state/render/provider pipeline. Pi appears in render details as a `pi N` source group. Uninstall removes only the managed extension and never deletes user-owned Pi extensions or other settings.
