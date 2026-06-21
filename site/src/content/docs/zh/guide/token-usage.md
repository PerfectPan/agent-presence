---
title: Token 统计
description: 按自然日统计 token,并给出美元估算。
---

`agent-presence usage` 按源统计 token 消耗,思路类似 [ccusage](https://github.com/ryoppippi/ccusage):它不 hook 智能体,而是事后扫描本地 transcript。

```bash
agent-presence usage            # 今日 + 近 7 天
agent-presence usage --days 7   # 单个窗口
agent-presence usage --json     # 结构化输出
```

## 自然日窗口

窗口按**自然日**对齐(从本地午夜起、含今天)。`今日` 从 0 点算、午夜归零——不会像滚动 24h 窗口那样在白天缩水。

## 各数据源

| 源 | Token 统计 |
| --- | --- |
| Claude Code | 支持 — 按价目表计价、去重、排除 `<synthetic>` |
| Codex | 支持 — 对会话累计总量做差分 |
| Pi | 支持 — 用 Pi 自己记录的成本 |
| Gemini CLI | 仅 presence — 本地无逐条 token 记录 |

无价目表的模型成本显示 `n/a`;token 数始终精确。可在 `~/.agent-presence/config.json` 按模型覆盖单价。

## 放进签名

用模板变量自由组装文案:

```bash
agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d}"
```

`{usage_1d}` 是今日;`{usage_7d}`(或任意 `{usage_Nd}`)是 N 个自然日。
