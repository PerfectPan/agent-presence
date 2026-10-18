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

Token 统计是驱动 presence 的同一张源表的一种能力：除 `dsh` 外的内置源都由 `@rivus/agent-kit` 解码本地 transcript，第三方源插件也可以自己扫描。

| 源          | Token 统计                                                                            |
| ----------- | ------------------------------------------------------------------------------------- |
| Claude Code | 支持 — 按模型请求解码、按请求 id 去重、排除 `<synthetic>`；按价目表计价               |
| Codex       | 支持 — 按模型调用解码，每条记录按它所在 rollout 自己的 service tier 计价              |
| Pi          | 支持 — 用 Pi 自己记录的成本                                                           |
| opencode    | 支持 — 读取本地 SQLite 存储（没有数据库时才读旧版 JSON 存储）；用 opencode 记录的成本 |
| Gemini CLI  | 支持 — 读取 `$GEMINI_CLI_HOME/.gemini/tmp` 下的本地会话 transcript；按价目表计价      |
| Grok        | 支持 — 按完成的回合解码，采用 Grok 记录的成本                                         |
| dsh         | 支持 — 由 setup 安装的 dsh 插件实时上报每次模型调用用量；按价目表计价                 |

每个解码器自行判断记录何时完成：Claude Code 的一条请求要等同一条会话通道里又写入了四条更新的请求、或该会话已静默 30 分钟才上报；opencode 的数据库消息要等它完成（数据库静默后会结算最后还在运行的消息）；Gemini CLI、Pi、Codex 的记录一旦写完立即计入。

徽标在这之上还有自己的规则：它在会话边界时刻刷新，且一天内只刷新该边界自己的来源。Claude 在当天最后一次 Claude 边界时仍未上报的请求，要等下一次 Claude 边界（且该会话已静默超过 30 分钟）才计入——如果当天没有下一次，徽标里当天就一直没有它们。`agent-presence usage` 按当前时间扫描，会更早报出这些请求。

无价目表的模型成本显示 `n/a`；token 数始终精确。Pi、opencode 与 Grok 会记录真实成本，直接采用。其余源优先使用内置的 LiteLLM 支持模型快照计价（例如 `gpt-5.5`、`claude-fable-5`、`deepseek-v4-pro`、`gemini-3-flash-preview`），再回退到少量旧别名价目表。若你的部署使用私有或未收录模型，可在 `~/.agent-presence/config.json` 按模型覆盖单价。

dsh 是唯一不扫 transcript 的源：`agent-presence setup` 会提示是否安装一个小型 Cordis 插件到 `~/.dsh/plugins/`（注册在对所有 profile 生效的 home 级 `~/.dsh/cordis.patch.yml`）。插件在每次模型调用后把 token 用量随 presence heartbeat 一起上报，`agent-presence` 追加到本地 usage 日志，`usage` 命令和签名徽标读回这份日志。随时可用 `pnpm run install:dsh-plugin` / `pnpm run uninstall:dsh-plugin`（或 `node dist/scripts/install-dsh-plugin.js`）安装或移除。

## 放进签名

用模板变量自由组装文案:

```bash
agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d}"
```

`{usage_1d}` 是今日;`{usage_7d}`(或任意 `{usage_Nd}`)是 N 个自然日。

窗口已整段翻过的徽标显示为 `—`：`{usage_1d}` 过一个本地零点后，`{usage_Nd}` 过 N 个零点后，不带天数的 `{usage}` 在其默认窗口翻过后（未配置时为一个零点）。`usage.showInSignature` 追加的标签则直接去掉。会话边界或 `agent-presence update` 让每个内置源都有了当天的快照后，数字恢复。扫描失败的那次刷新保留之前的缓存，徽标继续显示 `—`，直到之后的边界或 `update` 刷新成功。签名只由本机渲染和写入（hook 事件、`update`、延迟 flush 和 `reset` 之后，包括 macOS 电源事件触发的 reset），所以零点后没有任何写入时（机器空闲、睡眠或关机），已发布的签名会一直保留最后的值，包括昨天的 `今日`，直到下一次写入。
