---
title: Presence semantics
description: It counts agents that are working, not open windows.
---

`agent-presence` counts agents that are **actually working**, not merely open terminal windows.

![Presence state machine](/presence-state-machine.svg)

```text
SessionStart / UserPromptSubmit / PreToolUse / PostToolUse   -> running / heartbeat
Pi before_agent_start / turn_start / tool_execution_*         -> running / heartbeat
dsh agent/session-start / agent/pre-step / tools/*            -> running / heartbeat
Stop / SessionEnd / session.idle / agent_end / shutdown      -> finished
No heartbeat for 3 minutes                                    -> expired
Expired + later live heartbeat                                -> running again
Laptop sleep / lid close / screen sleep                       -> reset to 0
```

`finished` is explicit and ignores late heartbeats. `expired` is TTL-inferred, so a later live heartbeat reopens the same session. Opening the Pi TUI alone is not counted — presence activates once you submit a task.

## dsh

dsh has no managed hook settings; `agent-presence setup` prompts to install a small Cordis plugin (into `~/.dsh/plugins/`, registered in the home-level `~/.dsh/cordis.patch.yml` that applies to every profile). The plugin bridges `agent/session-start` → running, `agent/pre-step` / `tools/*` → heartbeat, and `agent/turn-stopping` → finished, and reports each model call's token usage alongside the heartbeat. Install or remove it any time with `pnpm run install:dsh-plugin` / `pnpm run uninstall:dsh-plugin`.
