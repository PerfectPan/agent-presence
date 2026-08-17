---
title: Presence 语义
description: 统计"正在干活"的智能体,而不是开着的窗口。
---

`agent-presence` 统计**真正在干活**的智能体,而不是开着的终端窗口。

![Presence 状态机](/presence-state-machine.svg)

```text
SessionStart / UserPromptSubmit / PreToolUse / PostToolUse   -> running / heartbeat
Pi before_agent_start / turn_start / tool_execution_*         -> running / heartbeat
dsh agent/session-start / agent/pre-step / tools/*            -> running / heartbeat
Stop / SessionEnd / session.idle / agent_end / shutdown      -> finished
3 分钟无心跳                                                   -> expired
expired 后又有心跳                                             -> 重新 running
笔记本休眠 / 合盖 / 息屏                                        -> 归零
```

`finished` 是显式的,会忽略迟到的普通心跳。`expired` 是按 TTL 推断的不活跃,之后来一个心跳会重新唤起同一个会话。仅打开 Pi TUI 不计入——只有提交任务后 presence 才激活。

## dsh

dsh 没有可托管的 hook 配置；`agent-presence setup` 会提示是否安装一个小型 Cordis 插件（装到 `~/.dsh/plugins/`，注册在对所有 profile 生效的 home 级 `~/.dsh/cordis.patch.yml`）。插件把 `agent/session-start` 映射为 running、`agent/pre-step` / `tools/*` 映射为 heartbeat、`agent/turn-stopping` 映射为 finished，并在 heartbeat 时顺带上报每次模型调用的 token 用量。随时可用 `pnpm run install:dsh-plugin` / `pnpm run uninstall:dsh-plugin` 安装或移除。
