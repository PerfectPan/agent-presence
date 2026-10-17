# Agent Presence 中文说明

[English](README.md) · [文档站](https://agent-presence.vercel.app)

Agent Presence 会把本机编码智能体的「在线/工作状态」和 token 用量同步到飞书个性签名的链接预览里。

```text
Codex / Claude Code / Gemini CLI / opencode / Pi / Grok / dsh
  -> 本地 presence 状态
  -> 防抖渲染
  -> 托管 slot（值存储）
  -> magic.solutionsuite.cn 上的 magic-builder FaaS 预览
  -> 飞书签名链接预览
```

`@rivus/agent-presence` 的核心是 presence，而不是飞书专用逻辑。默认输出是 `magic.solutionsuite.cn` 上的 **magic-builder** FaaS 预览：presence 值写入一个托管 slot，每次飞书拉取预览时由 FaaS 在服务端读取该值。之所以默认走 magic-builder，是因为飞书可能不渲染那个旧的直连预览页。

## 安装

需要 Node.js 22.13 或更高版本。仅支持 macOS 和 Linux —— Windows 会直接报错退出。macOS 用 Keychain 存凭据并安装 LaunchAgent 电源 watcher；Linux 用 libsecret，并以 TTL 清理代替 watcher。

已使用 0.9.0 或更早版本的用户，请先按下面的升级步骤操作，再替换安装的包。

```bash
pnpm add -g @rivus/agent-presence
agent-presence setup
```

不全局安装，直接用发布包：

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup
```

默认情况下，`setup` 用 npm 将自身的固定包版本安装到 `~/.agent-presence/runtime/<version>/`。hook 用 setup 当时的 Node 可执行文件直接运行本地 CLI；该 Node 路径失效时回退到 `PATH` 中的 `node`。只有 setup 安装缺失或损坏的 runtime 时需要 npm 和 registry 访问，hook 不运行 `npx`。`--hook-command package` 选择此默认模式，`npx` 保留为 `package` 的别名。

本地仓库开发安装使用 `absolute` 模式运行构建产物，不安装 runtime：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm link --global
agent-presence setup --hook-command absolute
```

包里也暴露了兼容命令 `agent-signature`，旧 hook 可以继续工作。实现边界与信任边界见 [docs/architecture.md](docs/architecture.md)。

## 从 0.10.0 升级

安装本版本后运行 `agent-presence setup` 即可。setup 安装 runtime 并更新 shim，已安装的智能体命令保持不变，因此这次更新不会增加 hook 重新信任流程，也无需先卸载。

## 从 0.9.0 或更早版本升级

如果 setup 列出此前卸载时保留的文件，请先将它们移出安装位置，不再需要时也可删除。这些文件也可能由本版本安装，例如卸载时保留的已修改 hook 文件。即使同时列出了需要替换的项目，也必须先处理保留文件，再运行任何旧卸载器。其余旧安装在升级前运行旧版本自己的卸载命令，不加 `--credentials` 或 `--all`，以保留凭据、配置和状态：

```bash
npx --yes @rivus/agent-presence@<previous-version> uninstall
```

对需要替换的 hook 命令中固定的每个不同版本，分别运行卸载命令。只要有一个需要替换的项目不是固定版本的 hook 命令，例如桥接文件或 opencode 配置引用，就额外运行 `0.9.0`，即使其他项目已固定版本。从 checkout 安装的用户也可在更新 checkout 前运行 `node <checkout>/dist/src/cli.js uninstall`。然后安装本版本并运行 `agent-presence setup`。本版本的卸载只移除 harness 安装记录中的智能体产物，不能代替这一步；后续升级直接重新运行 setup。

setup 会列出检测到的旧版本项目和此前卸载时保留的文件，在队列恢复、登录和安装确认前退出。保留文件属于用户，请手动移动或删除；旧卸载器会删除它们。旧卸载器遗漏的改名副本或手改项目也需要手动清理。旧安装目标覆盖变量须保持设置，再运行旧版本卸载；本版本忽略这些变量，并在设置时警告。

checkout 路径不含 presence 标记的旧绝对路径 hook 命令可能无法被检测。旧版本卸载后请检查智能体配置，尤其是带引号的 checkout 路径。旧卸载器还会移除其他工具在 Claude/Codex/Gemini 中包含 `dist/src/cli.js hook` 的 hook，必要时先保存再恢复。切换到稳定 shim 预计需要在 Codex 中重新信任一次 hook；后续只更新 shim 时，hook 定义保持稳定。详见[升级指引](https://agent-presence.vercel.app/zh/guide/install/#从-090-或更早版本升级)。

## 使用流程

1. 运行 `agent-presence setup`。
2. 如果需要登录，扫二维码完成授权，这会保存 slot 凭据。
3. 先处理列出的配置冲突，再查看完整安装计划并确认，setup 随后安装 hook 和 macOS 电源 watcher。
4. 出现提示时粘贴 Magic-Builder token，让 setup 发布预览 FaaS —— 在飞书里打开妙笔机器人、发送 `dev`、从回复复制 token。
5. 运行 `agent-presence url`，把输出粘贴到飞书个人资料签名的自定义链接预览里。

`setup` 在确认安装计划前不会写入智能体配置。非交互终端需要 `setup --yes` 才会应用无冲突的计划；有冲突时即使传了 `--yes` 也会退出，交互终端仍需明确确认。确认后，setup 在 `package` 模式下安装或复用固定版本的 runtime，再写入 shim、应用计划、写入 harness 安装记录并立即验证 kit 产物。runtime 安装失败时，setup 会在写入 shim 或任何智能体配置之前退出。验证成功后，依次运行电源 watcher 步骤、无需询问地更新已有 presence dsh 插件或在交互终端询问是否首次安装，再配置 provider。

安装的 hook、dsh 插件和 macOS 电源 watcher 调用 `~/.agent-presence/bin/agent-presence` 中的稳定 shim。setup 更新其中的 Node/CLI 路径，智能体中的 hook 命令保持不变。setup 成功后，在 runtime 锁内保留本次版本和旧 shim、当前 shim 指向的 runtime，删除其他版本和中断安装残留的目录；卸载会移除 shim 和整个 runtime 目录。绝对路径模式要求 checkout 持续可用。Claude Code、Codex、Gemini CLI 和 Grok 的命令式 hook 按各自的原生单位设置五秒超时；opencode/Pi 桥接仅对同步结束事件的交付设置五秒超时，其他事件异步发送，不设置子进程超时。Gemini 使用自己的事件名。Claude hook 放在插件中，避免写入 Cursor 也会读取的共享 settings 文件。切换到 shim 命令预计需要在 Codex 中重新审阅一次 hook；后续只更新 shim 时，安装命令保持稳定。见[安装位置与检查](https://agent-presence.vercel.app/zh/guide/install/#安装位置)。

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

dsh 是个例外：不扫它的 transcript，而是由 setup 时可选安装的 dsh 插件在每次模型调用后把 token 用量通过 hook payload 实时上报，`agent-presence` 追加到本地 usage 日志。`usage` 命令和签名徽标读回这份日志，所以 dsh 和其他扫 transcript 的来源一样参与窗口统计和总计。

```bash
agent-presence usage            # 今日和近 7 天并排
agent-presence usage --days 7   # 单个自然日窗口
agent-presence usage --json     # 给脚本用的结构化输出
```

可以用渲染变量（`{usage_1d}`、`{usage_7d}`）或 `usage.showInSignature: true` 把它放进签名。每个智能体的会话边界只刷新自己来源的缓存贡献；provider 的延迟 flush 只发布缓存、不重新扫描，`agent-presence update` 才执行显式全量刷新，签名层随后汇总。独立的 `usage` 命令每次都会做实时全量扫描，而签名有意展示最近一次各来源边界的缓存快照。支持模型会按内置 LiteLLM 快照计价，并区分模型特有的缓存 TTL 价格和每条 Codex 记录所在 rollout 自己的 service tier（私有模型仍可用 pricing override）；数据来源和过期徽标的 `—` 占位见 [Token 用量](https://agent-presence.vercel.app/zh/guide/token-usage/)。

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
agent-presence setup            # 还有：--login --skip-login --no-hooks --hook-command absolute --yes
agent-presence url
agent-presence status           # --remote 查看已发布的预览
agent-presence usage            # --days N / --json
agent-presence doctor           # harness 检查；--json
agent-presence inventory        # harness 安装记录；--json
agent-presence update --force
agent-presence reset --force
agent-presence uninstall        # --credentials / --all
agent-presence config show
```

hook 由 `setup` 自动安装，也可直接调用，如 `agent-presence hook --source codex --event SessionStart`，它们不会阻塞编码智能体。完整命令见 [Commands](https://agent-presence.vercel.app/zh/reference/commands/)。

## Sources

被统计的智能体（`codex`、`claude`、`gemini`、`opencode`、`pi`、`grok`、`dsh`）是一张**源表**，你的配置可以扩展、覆盖或禁用它。新增一个源可用纯配置的 `match` 规则、本地 `handler` 模块，或直接安装一个包：

```bash
agent-presence source add @your-scope/agent-presence-youragent --yes   # 内网源加 --registry <url>
agent-presence source list
agent-presence source remove youragent
```

源插件在进程内运行、能读取你的 slot 凭据，所以 `add` 需要确认，且只应添加你信任的包。覆盖或禁用内置源通过 `~/.agent-presence/config.json` 里的 `plugins.sources`。完整指南见 [Sources](https://agent-presence.vercel.app/zh/guide/sources/)。

## 日志

hook 和 provider 活动写到 `~/.agent-presence/agent-presence.log`（用 `AGENT_PRESENCE_LOG_FILE` 覆盖）。日志超过 5 MiB 后会自动压缩，保留最近约 1 MiB 供排障。按上面的升级步骤操作后，已有 macOS 安装需运行 `agent-presence setup --skip-login`，让常驻的 power watcher 同步获得清理策略。bearer token、完整 Authorization 头、二维码 ticket、完整 slot 值都不会被记录。

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
