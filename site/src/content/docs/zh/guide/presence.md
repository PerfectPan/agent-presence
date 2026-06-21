---
title: Presence 语义
description: 统计"正在干活"的智能体,而不是开着的窗口。
---

`agent-presence` 统计**真正在干活**的智能体,而不是开着的终端窗口。

![Presence 状态机](/presence-state-machine.svg)

```text
SessionStart / UserPromptSubmit / PreToolUse / PostToolUse   -> running / heartbeat
Pi before_agent_start / turn_start / tool_execution_*         -> running / heartbeat
Stop / SessionEnd / session.idle / agent_end / shutdown      -> finished
3 分钟无心跳                                                   -> expired
expired 后又有心跳                                             -> 重新 running
笔记本休眠 / 合盖 / 息屏                                        -> 归零
```

`finished` 是显式的,会忽略迟到的普通心跳。`expired` 是按 TTL 推断的不活跃,之后来一个心跳会重新唤起同一个会话。仅打开 Pi TUI 不计入——只有提交任务后 presence 才激活。
