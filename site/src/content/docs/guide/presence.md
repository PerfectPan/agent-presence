---
title: Presence semantics
description: It counts agents that are working, not open windows.
---

`agent-presence` counts agents that are **actually working**, not merely open terminal windows.

![Presence state machine](/presence-state-machine.svg)

Installed hooks map native events as follows:

| Agent       | Start → running                     | Heartbeat                                                                                   | Finish → finished                                                         |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Claude Code | `SessionStart`                      | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`                                             | `Stop`, `StopFailure`, `SessionEnd`                                       |
| Codex       | `SessionStart`                      | `UserPromptSubmit`, `PreToolUse`                                                            | `Stop`                                                                    |
| Gemini CLI  | `SessionStart`, `BeforeAgent`       | `BeforeTool`, `AfterTool`                                                                   | `AfterAgent`, `SessionEnd`                                                |
| Grok        | `session_start`                     | `user_prompt_submit`, `pre_tool_use`, `post_tool_use`                                       | `stop`, `stop_failure`, `session_end`                                     |
| opencode    | `session.created`                   | Message, tool, edit and other activity; non-idle `session.status` (including busy)          | Idle `session.status`, `session.idle`, `session.error`, `session.deleted` |
| Pi          | `before_agent_start`, `agent_start` | `turn_start`, `turn_end`, `tool_call`, `tool_execution_*`, `session_compact`, `ui_prompt_*` | `agent_end`, `agent_settled`, `session_shutdown`                          |
| dsh         | `agent/session-start`               | `agent/pre-step`, `tools/result`, `agent/turn-stopping`, running `agent/status`             | Idle `agent/status`, `agent/disposed`, `session/disposed`                 |

Claude Code's `SubagentStart` / `SubagentStop` and Grok's `subagent_start` / `subagent_stop` start and finish the subagent's own session. Grok's PascalCase names have the same mapping. Pi's `session_start` is ignored: opening its TUI alone is not counted.

`finished` is explicit and ignores ordinary late heartbeats; `UserPromptSubmit` (Grok: `user_prompt_submit`; dsh: `agent/status` running) can reopen it. No heartbeat for 3 minutes (the default TTL) makes a session `expired`; a later live heartbeat reopens it. On macOS, sleep, lid close, screen sleep and wake reset the active count to 0.

## dsh

dsh has no managed hook settings; `agent-presence setup` prompts to install a small Cordis plugin (into `~/.dsh/plugins/`, registered in the home-level `~/.dsh/cordis.patch.yml` that applies to every profile). Alongside the lifecycle events above, the plugin reports each main-session model call's token usage in a heartbeat. Install or remove it any time with `pnpm run install:dsh-plugin` / `pnpm run uninstall:dsh-plugin`.
