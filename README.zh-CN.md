# Agent Presence 中文说明

[English](README.md) · [文档站](https://agent-presence.vercel.app)

Agent Presence 会把本机编码智能体的「在线/工作状态」和 token 用量同步到飞书个性签名的链接预览里。

```text
Codex / Claude Code / Gemini CLI / opencode / Pi hooks
  -> 本地 presence 状态
  -> 防抖渲染
  -> 托管 slot（值存储）
  -> magic.solutionsuite.cn 上的 magic-builder FaaS 预览
  -> 飞书签名链接预览
```

`@rivus/agent-presence` 的核心是 presence，而不是飞书专用逻辑。默认输出是 `magic.solutionsuite.cn` 上的 **magic-builder** FaaS 预览：presence 值写入一个托管 slot，每次飞书拉取预览时由 FaaS 在服务端读取该值。之所以默认走 magic-builder，是因为飞书可能不渲染那个旧的直连预览页。

## 安装

仅支持 macOS 和 Linux —— Windows 会直接报错退出。macOS 用 Keychain 存凭据并安装 LaunchAgent 电源 watcher；Linux 用 libsecret，并以 TTL 清理代替 watcher。

```bash
pnpm add -g @rivus/agent-presence
agent-presence setup
```

不全局安装，直接用发布包：

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup
```

如果智能体环境启动 hook 时 `PATH` 很窄，用绝对路径安装 hook：

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --hook-command absolute
```

本地仓库开发安装：

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup
```

包里也暴露了兼容命令 `agent-signature`，旧 hook 可以继续工作。实现边界与信任边界见 [docs/architecture.md](docs/architecture.md)。

## 使用流程

1. 运行 `agent-presence setup`。
2. 如果需要登录，扫二维码完成授权，这会保存 slot 凭据。
3. 出现提示时粘贴 Magic-Builder token，让 setup 发布预览 FaaS —— 在飞书里打开妙笔机器人、发送 `dev`、从回复复制 token。
4. setup 会安装 Codex、Claude Code、Gemini CLI、opencode、Pi 的 hook，以及 macOS 电源 watcher。
5. 运行 `agent-presence url`，把输出粘贴到飞书个人资料签名的自定义链接预览里。

重复运行 `setup` 会复用已有登录（无需再次扫码）。签名 URL —— `https://magic.solutionsuite.cn/r?fid=<faasId>` —— 不含任何凭据。本地配置、状态和日志在 `~/.agent-presence/`。

> 还有一个旧的直连预览 provider（`--provider feishu-signature`，无需 Magic-Builder token），但飞书可能已经不再渲染它。仍想用的话见 [Providers 文档](https://agent-presence.vercel.app/zh/guide/providers/)。

## Presence

统计的是「正在工作的智能体」，而不是「打开了多少个终端窗口」。一个 session 会从 running 进入 `finished`（明确结束，忽略迟到 heartbeat）或 `expired`（3 分钟无 heartbeat；后续真实 heartbeat 可恢复为 running）。睡眠、合盖、唤醒都会把计数重置为 0，但会保留已缓存的 token 用量。

```text
0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P
```

完整事件映射见 [Presence 语义](https://agent-presence.vercel.app/zh/guide/presence/)。

## Token 用量

`agent-presence usage` 在事后扫描各智能体的本地 transcript（不 hook 它们），思路类似 [`ccusage`](https://github.com/ryoppippi/ccusage)，按**自然日**窗口统计 —— `今日` 从本地零点算起，而不是像滚动 24h 窗口那样随时间滑动。

```bash
agent-presence usage            # 今日和近 7 天并排
agent-presence usage --days 7   # 单个自然日窗口
agent-presence usage --json     # 给脚本用的结构化输出
```

可以用渲染变量（`{usage_1d}`、`{usage_7d}`）或 `usage.showInSignature: true` 把它放进签名。每个智能体的会话边界只刷新自己来源的缓存贡献；provider 的延迟 flush 只发布缓存、不重新扫描，`agent-presence update` 才执行显式全量刷新，签名层随后汇总。独立的 `usage` 命令每次都会做实时全量扫描，而签名有意展示最近一次各来源边界的缓存快照。支持模型会按内置 LiteLLM 快照计价，包括模型特有的缓存 TTL、Codex fast tier 倍率，以及单次输入超过 272K 后的整请求长上下文价格；复制到多个 Codex 分支 session 的相同 usage event 会跨文件去重（私有模型仍可用 pricing override）。数据来源和过期徽标的 `—` 占位见 [Token 用量](https://agent-presence.vercel.app/zh/guide/token-usage/)。

## 自定义文案

```bash
agent-presence config render \
  --zero "AI 牛马下班了" \
  --one "{total} 个 AI 牛马正在搬砖 | {details}" \
  --many "{total} 个 AI 牛马并行搬砖 | {details}"
```

`{total}` 是活跃智能体数量，`{details}` 是分 source 的计数（如 `codex 1 · claude 1`）。也支持 `AGENT_PRESENCE_RENDER_*` 环境变量覆盖；旧的 `AGENT_SIGNATURE_*` 名仍然接受。

## 常用命令

```bash
agent-presence setup            # 还有：--login --skip-login --no-hooks --hook-command absolute
agent-presence url
agent-presence status           # --remote 查看已发布的预览
agent-presence usage            # --days N / --json
agent-presence update --force
agent-presence reset --force
agent-presence uninstall        # --credentials / --all
agent-presence config show
```

hook 由 `setup` 自动安装，也可直接调用，如 `agent-presence hook --source codex --event SessionStart`，它们不会阻塞编码智能体。完整命令见 [Commands](https://agent-presence.vercel.app/zh/reference/commands/)。

## Sources

被统计的智能体（`codex`、`claude`、`gemini`、`opencode`、`pi`）是一张**源表**，你的配置可以扩展、覆盖或禁用它。新增一个源可用纯配置的 `match` 规则、本地 `handler` 模块，或直接安装一个包：

```bash
agent-presence source add @your-scope/agent-presence-youragent --yes   # 内网源加 --registry <url>
agent-presence source list
agent-presence source remove youragent
```

源插件在进程内运行、能读取你的 slot 凭据，所以 `add` 需要确认，且只应添加你信任的包。覆盖或禁用内置源通过 `~/.agent-presence/config.json` 里的 `plugins.sources`。完整指南见 [Sources](https://agent-presence.vercel.app/zh/guide/sources/)。

## 日志

hook 和 provider 活动写到 `~/.agent-presence/agent-presence.log`（用 `AGENT_PRESENCE_LOG_FILE` 覆盖）。日志超过 5 MiB 后会自动压缩，保留最近约 1 MiB 供排障。已有 macOS 安装升级后需运行一次 `agent-presence setup --skip-login`，让常驻的 power watcher 同步获得清理策略。bearer token、完整 Authorization 头、二维码 ticket、完整 slot 值都不会被记录。

## 文档

完整文档在 **https://agent-presence.vercel.app**：

- [安装](https://agent-presence.vercel.app/zh/guide/install/) · [快速开始](https://agent-presence.vercel.app/zh/guide/quick-start/)
- [Providers](https://agent-presence.vercel.app/zh/guide/providers/) —— magic-builder（默认）与遗留的直连预览
- [Sources](https://agent-presence.vercel.app/zh/guide/sources/) —— 添加、覆盖或禁用被统计的智能体
- [Presence](https://agent-presence.vercel.app/zh/guide/presence/) · [Token 用量](https://agent-presence.vercel.app/zh/guide/token-usage/)
- [架构](https://agent-presence.vercel.app/zh/project/architecture/) · [命令](https://agent-presence.vercel.app/zh/reference/commands/)

## 贡献与发布

开发环境、必跑检查，以及 Changesets / npm Trusted Publishing 发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Agent Skill

可复用的操作员说明见 [skills/agent-presence/SKILL.md](skills/agent-presence/SKILL.md)。
