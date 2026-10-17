---
'@rivus/agent-presence': minor
---

Install setup hooks only for agents detected through PATH commands, known applications or agent-owned session/state and credential-file existence. Bare agent homes, presence hooks, shared settings and MCP configuration do not count; detection runs no agent commands and reads no credential contents. Use `--agents <id,...>` to choose supported agents explicitly, including agents installed but never run and absent from PATH.

Keep existing hooks for unselected agents and name them only when presence owns their installation records, with separate update and all-agent uninstall instructions. Verify only selected agents' entries and desired locations through the kit. When no agents are found, still prepare the runtime and shim before watcher, dsh and provider setup.
