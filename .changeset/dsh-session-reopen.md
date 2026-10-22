---
'@rivus/agent-presence': patch
---

dsh sessions no longer show as finished after the first turn. The managed dsh plugin reports `Stop` when the agent goes idle and `UserPromptSubmit` when it starts running again, instead of reporting `Stop` on `agent/turn-stopping`, which fires on every turn and can be followed by more steps. Rerun `agent-presence setup` to rewrite an installed plugin.
