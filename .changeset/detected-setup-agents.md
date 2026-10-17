---
'@rivus/agent-presence': minor
---

Install setup hooks only for detected agents, with `--agents <id,...>` to choose supported agents explicitly. Keep existing hooks for unselected agents and name them only when presence owns their installation records, with separate update and uninstall instructions. Continue watcher, dsh and provider setup when no agents are found.
