---
title: Presence semantics
description: It counts agents that are working, not open windows.
---

`agent-presence` counts agents that are **actually working**, not merely open terminal windows.

![Presence state machine](/presence-state-machine.svg)

```text
SessionStart / UserPromptSubmit / PreToolUse / PostToolUse   -> running / heartbeat
Pi before_agent_start / turn_start / tool_execution_*         -> running / heartbeat
Stop / SessionEnd / session.idle / agent_end / shutdown      -> finished
No heartbeat for 3 minutes                                    -> expired
Expired + later live heartbeat                                -> running again
Laptop sleep / lid close / screen sleep                       -> reset to 0
```

`finished` is explicit and ignores late heartbeats. `expired` is TTL-inferred, so a later live heartbeat reopens the same session. Opening the Pi TUI alone is not counted — presence activates once you submit a task.
