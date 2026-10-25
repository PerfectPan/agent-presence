---
title: Presence 语义
description: 统计"正在干活"的智能体,而不是开着的窗口。
---

`agent-presence` 统计**真正在干活**的智能体,而不是开着的终端窗口。

![Presence 状态机](/presence-state-machine.svg)

已安装的 hook 按下表映射各智能体的原生事件：

| 智能体      | 开始 → running                      | 心跳                                                                                        | 完成 → finished                                                              |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Claude Code | `SessionStart`                      | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`                                             | `Stop`, `StopFailure`, `SessionEnd`                                          |
| Codex       | `SessionStart`                      | `UserPromptSubmit`, `PreToolUse`                                                            | `Stop`                                                                       |
| Gemini CLI  | `SessionStart`, `BeforeAgent`       | `BeforeTool`, `AfterTool`                                                                   | `AfterAgent`, `SessionEnd`                                                   |
| Grok        | `session_start`                     | `user_prompt_submit`, `pre_tool_use`, `post_tool_use`                                       | `stop`, `stop_failure`, `session_end`                                        |
| opencode    | `session.created`                   | 消息、工具、编辑等活动；非 idle 的 `session.status`（包括 busy）                            | idle 的 `session.status`、`session.idle`、`session.error`、`session.deleted` |
| Pi          | `before_agent_start`, `agent_start` | `turn_start`, `turn_end`, `tool_call`, `tool_execution_*`, `session_compact`, `ui_prompt_*` | `agent_end`, `agent_settled`, `session_shutdown`                             |
| dsh         | `agent/session-start`               | `agent/pre-step`、`tools/result`、`agent/turn-stopping`、`agent/status` 变成 running        | `agent/status` 变成 idle、`agent/disposed`、`session/disposed`               |

Claude Code 的 `SubagentStart` / `SubagentStop` 和 Grok 的 `subagent_start` / `subagent_stop` 开始和完成子智能体自己的会话。Grok 的 PascalCase 名称采用相同映射。Pi 的 `session_start` 被忽略，仅打开 TUI 不计入。

`finished` 是显式完成，会忽略迟到的普通心跳；`UserPromptSubmit`（Grok 为 `user_prompt_submit`，dsh 为 `agent/status` 变成 running）可以重新唤起它。3 分钟无心跳（默认 TTL）会使会话变成 `expired`，之后的实时心跳会重新唤起它。在 macOS 上，休眠、合盖、息屏和唤醒会把活跃计数归零。

## dsh

dsh 没有可托管的 hook 配置；`agent-presence setup` 会提示是否安装一个小型 Cordis 插件（装到 `~/.dsh/plugins/`，注册在对所有 profile 生效的 home 级 `~/.dsh/cordis.patch.yml`）。除了上表中的生命周期事件，插件还会通过心跳上报主会话每次模型调用的 token 用量。随时可用 `pnpm run install:dsh-plugin` / `pnpm run uninstall:dsh-plugin` 安装或移除。
