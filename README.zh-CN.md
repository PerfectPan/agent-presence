# Agent Presence 中文说明

[English](README.md)

Agent Presence 会把本机编码智能体的生命周期事件同步到飞书个性签名的链接预览里。

```text
Codex / Claude Code / Gemini CLI / opencode / Pi Coding Agent hooks
-> 本地 presence 状态
-> 防抖渲染
-> l.garyyang slot 存储（始终）
-> magic.solutionsuite.cn 上的 magic-builder FaaS 预览（默认）-> 飞书签名链接预览
   （备选：通过 --provider feishu-signature 使用 l.garyyang.work 直连预览）
```

`@rivus/agent-presence` 的核心是 presence，而不是飞书专用逻辑。默认输出路径是 `magic.solutionsuite.cn` 上的 magic-builder FaaS 预览，因为飞书可能不渲染 `l.garyyang.work` 直连预览页（它可能收紧个性签名预览的 iframe 白名单），所以这个前端更可靠。该预览仍然建立在 `l.garyyang` slot 之上：presence 值始终写入 l.garyyang slot，每次飞书拉取链接预览时由 FaaS 在服务端读取该值。`l.garyyang.work` 直连预览仍可通过 `--provider feishu-signature` 使用。hook、状态、渲染和 provider 的分层以后可以继续扩展。

## 安装

Agent Presence 当前支持 macOS 和 Linux。CLI 和安装脚本会检测不支持的平台并给出明确错误；Windows 暂不支持。

macOS 使用 Keychain 存凭据，并安装 LaunchAgent 电源 watcher。Linux 使用 `secret-tool` / libsecret 存凭据；由于 systemd user service 和 logind 信号在不同发行版上不够稳定，Linux 会跳过电源 watcher，依赖 TTL 清理过期 session。

从包仓库全局安装：

```bash
pnpm add -g @rivus/agent-presence
agent-presence setup
```

默认 provider 是 `magic-builder`，所以不带 `--provider` 的命令都指向它。首次 `setup` 会先跑 l.garyyang 扫码登录（保存 slot 凭据），再提示你粘贴一个 Magic-Builder token 用于发布预览 FaaS。如果想改用 `l.garyyang.work` 直连预览（无需 Magic-Builder token），加上 `--provider feishu-signature`。

不全局安装，直接使用发布包：

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup
```

如果智能体环境启动 hook 时 `PATH` 很窄，用绝对路径安装 hook：

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --hook-command absolute
```

Codex 可能要求你在 Codex 设置中批准更新后的 hook。`setup` 会安装 hook 并打印提醒，但不会直接修改 Codex 的信任状态。

本地仓库开发安装：

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup
```

包里也暴露了兼容命令 `agent-signature`，旧 hook 可以继续工作，新安装默认使用 `agent-presence`。

## 使用流程

1. 运行 `agent-presence setup`（默认 provider 为 `magic-builder`）。
2. 如果需要登录，扫 l.garyyang 二维码完成授权，这会保存 slot 凭据。
3. 出现提示时粘贴 Magic-Builder token，让 setup 发布预览 FaaS（获取方式见下方 Provider 中的 `magic-builder` provider 一节）。
4. 让 setup 安装 Codex、Claude Code、Gemini CLI、opencode、Pi Coding Agent 集成，以及当前平台支持的 watcher。
5. 运行 `agent-presence url`。
6. 把输出 URL 粘贴到飞书个人资料签名的自定义链接预览中。

如果想改用 `l.garyyang.work` 直连预览（无需 Magic-Builder token），在 `setup` 和 `url` 上加 `--provider feishu-signature`。

`setup` 会把凭据放在 macOS Keychain、Linux libsecret，或显式环境变量中，不会把凭据写进飞书签名 URL。本地配置、状态、日志和未来托管运行时默认在 `~/.agent-presence/`。

## 常用命令

不带 `--provider` 的命令指向默认的 `magic-builder` provider：

```bash
agent-presence setup
agent-presence setup --login
agent-presence setup --skip-login
agent-presence setup --no-hooks
agent-presence setup --hook-command absolute
agent-presence uninstall
agent-presence uninstall --credentials
agent-presence uninstall --all
agent-presence url
agent-presence status
agent-presence status --remote
agent-presence update --force
agent-presence reset --force
agent-presence config show
agent-presence config render --zero "AI 牛马下班了" --one "{total} 个 AI 牛马正在搬砖 | {details}" --many "{total} 个 AI 牛马并行搬砖 | {details}"
```

首次 `setup` 会先跑 l.garyyang 扫码登录（保存 slot 凭据），再提示粘贴 Magic-Builder token 用于发布预览 FaaS。

如果想改用 `l.garyyang.work` 直连预览（无需 Magic-Builder token），加上 `--provider feishu-signature`：

```bash
agent-presence login --provider feishu-signature
agent-presence setup --provider feishu-signature
agent-presence url --provider feishu-signature
agent-presence status --provider feishu-signature --remote
agent-presence config provider feishu-signature --base-url "https://l.garyyang.work" --preview-base-url "https://l.garyyang.work/" --image-key "img_xxx" --target-url "https://example.com"
```

hook 会由 `setup` 自动安装，也可以直接调用：

```bash
agent-presence hook --source codex --event SessionStart
agent-presence hook --source claude --event SessionStart --silent
agent-presence hook --source gemini --event SessionStart --silent
agent-presence hook --source opencode --event SessionStart --silent
agent-presence hook --source pi --event SessionStart --silent
agent-presence hook --source codex --event Stop
```

hook 不会阻塞编码智能体。Codex hook 输出 `{}`；Claude、Gemini、opencode 和 Pi hook 静默运行。

## Token 用量

`agent-presence usage` 按**自然日窗口**统计 token 消耗，思路对标
[`ccusage`](https://github.com/ryoppippi/ccusage)：它不 hook 智能体，而是事后扫描
本地会话记录。

```bash
agent-presence usage            # 今日 与 近 7 天 并排展示
agent-presence usage --days 7   # 单个自然日窗口
agent-presence usage --json     # 结构化输出，便于脚本处理
```

各 source 的记录位置与成本算法：

| Source | 会话记录 | 成本 |
| --- | --- | --- |
| `claude` | `~/.claude/projects/**/*.jsonl`（遵循 `CLAUDE_CONFIG_DIR`） | 按价格表定价；按 `message.id` + `requestId` 去重并保留最后（最大）一次；排除 `<synthetic>` turn —— 已对照 `ccusage` 验证 |
| `codex` | `~/.codex/sessions/` 与 `~/.codex/archived_sessions/` | 按价格表定价；对每会话的累计 `total_token_usage` 做差分（直接累加每事件的 `last_token_usage` 会多算约 1.6 倍） |
| `pi` | `~/.pi/agent/sessions/**/*.jsonl` | 直接使用 Pi 在会话记录里已记下的成本 |
| `gemini` | — | 不统计：Gemini 不在本地持久化每条消息的 token 用量 |

N 天窗口覆盖包含今天在内的 N 个本地自然日 ——
`[startOfLocalDay(now) - (N-1)*24h, now)`。也就是说 `今日`（1 天）从本地 0 点起算、
在 00:00 归零，而不是像滚动 24h 窗口那样随旧活动老化而中途往下掉。当某个模型不在
价格表中时，成本显示为 `n/a`；token 数量始终精确。

默认价格是尽力而为的估算，会随时间漂移；可以按模型（每百万 token 多少美元）覆盖，
无需改代码：

```jsonc
// ~/.agent-presence/config.json
{
  "usage": {
    "showInSignature": false,        // 在签名标题后追加 "今日 …"
    "signatureWindowDays": 1,        // 签名 badge 使用的窗口
    "pricing": { "opus": { "input": 15, "output": 75 } }
  }
}
```

签名里的用量由渲染模板变量驱动，所以由你自己拼标签、自己选要展示的窗口：

| 变量 | 含义 |
| --- | --- |
| `{usage}` | 默认窗口（`usage.signatureWindowDays`，默认 1）的 badge |
| `{usage_1d}` | 1 天自然日 badge，例如 `2.1M · $4.50` |
| `{usage_7d}` | 7 天自然日 badge —— 任意 `{usage_Nd}` 都可用 |

```bash
agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d} · 近7天 {usage_7d}"
```

模板里引用任意 `{usage*}` token 都会触发对它所命名的窗口的扫描。零配置方式：把
`usage.showInSignature` 设为 `true`（或 `AGENT_PRESENCE_USAGE_IN_SIGNATURE=1`），
即可在不动模板的情况下自动追加默认窗口（1 天标注为 `今日`，否则为 `近N天`）。

badge 只在**会话边界事件**（会话开始或结束）时做全量重扫刷新；高频工具事件复用
缓存的 badge，不触发扫描。因为每次扫描读取的是整个窗口，单次刷新总能得到完整、
正确的总量 —— 所以只在边界刷新即可保持准确，无需后台定时器或 cron。代价是：会话进行
中时，badge 反映的是上一次边界时的总量，而非实时进行中的计数。

因为机器空闲或关机时不运行任何进程，缓存 badge 可能比其窗口活得久（例如昨天的
`今日` 总量第二天早上仍在显示）。为避免悄悄展示一个已经不对的数字，当某个 badge 的
整个窗口自上次计算以来已经翻过 —— `今日` 过一个午夜、`近7天` 过七天 —— 时，它会渲染成
`—`，直到下一次会话边界刷新重新计算。你在模板里写的标签不变，只有数值塌缩为占位符。

## Presence 语义

这里统计的是“正在工作的智能体”，不是“打开了多少个终端窗口”。

```text
SessionStart / UserPromptSubmit / PreToolUse / PostToolUse -> running / heartbeat
Pi before_agent_start / turn_start / tool_execution_*      -> running / heartbeat
Stop / SessionEnd / session.idle / agent_end / session_shutdown -> finished
3 分钟无 heartbeat                                             -> 过期
过期后又收到真实 heartbeat                                     -> 回到 running
睡眠 / 合盖 / 屏幕睡眠                                         -> 重置为 0
唤醒                                                          -> 再次重置为 0
```

`finished` 是明确结束，会忽略普通迟到 heartbeat；`expired` 只是 TTL 推断的不活跃，同一个 session 后续又有真实 heartbeat 时可以恢复为 running。

Pi 的语义与其他 source 略有不同：单纯打开 `pi` TUI 不会算作 active，只有当用户提交任务、Pi 触发 `before_agent_start` 时才开始计数。这样可以避免“打开 Pi 但没干活”被误统计。

默认渲染：

```text
0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P
```

渲染结果最长 200 个字符。

## Hook 和 Watcher

`agent-presence setup` 会安装：

- `~/.codex/hooks.json` 里的 Codex hooks
- `~/.claude/settings.json` 里的 Claude Code hooks
- `~/.gemini/settings.json` 里的 Gemini CLI hooks
- `~/.config/opencode/plugins/agent-presence.js` 里的 opencode plugin
- `~/.pi/agent/extensions/agent-presence.ts` 里的 Pi Coding Agent 扩展
- macOS LaunchAgent power watcher；Linux 会跳过 watcher，并依赖 TTL 清理过期 session

Pi 扩展会被 `pi` 自动发现并加载，订阅 Pi 自己的生命周期事件（`before_agent_start`、`turn_start`、`tool_execution_*`、`agent_end`、`session_shutdown`），不会扫描进程或终端窗口。重复执行 `setup` 只会覆盖这一个托管文件；`uninstall` 只会删除这一个文件，用户自己的其他 Pi 扩展和设置都保留。

macOS power watcher 会监听合盖、系统睡眠、屏幕睡眠、唤醒、关机、重启和登出，每次执行：

```bash
agent-presence reset --force --silent
```

突然断电、强制关机、网络异常或 provider 限频可能延迟远端 slot 更新；macOS 唤醒时会再次 reset，把远端状态拉回 0。Linux setup 会打印 watcher skip 信息，3 分钟 TTL 会清理过期 session。

卸载本地 hook、opencode plugin 和 macOS power watcher：

```bash
agent-presence uninstall
```

默认卸载会保留凭据、本地状态和 provider 配置，后续可以用 `agent-presence setup --skip-login` 重新安装而不重新扫码。

同时清理登录凭据和 slot 配置：

```bash
agent-presence uninstall --credentials
```

清理 hook、凭据、slot 配置和本地状态：

```bash
agent-presence uninstall --all
```

## Provider

默认 provider id 是 `magic-builder`。它是建立在 `feishu-signature` slot 后端之上的预览前端，下面先介绍；随后是作为底层 slot 存储和直连预览备选的 `feishu-signature`。

### `magic-builder` provider（Magic-Builder FaaS 桥接，默认）

`magic-builder` 是默认 provider。它是一个预览前端，而不是独立的存储后端：它向 `magic.solutionsuite.cn` 发布一个小 FaaS，每次飞书拉取链接预览时，该 FaaS 在服务端运行，从 l.garyyang slot 读取当前值并作为预览标题返回。之所以设为默认，是因为飞书可能不渲染 `l.garyyang.work` 直连页（它可能收紧个性签名预览的 iframe 白名单），而 `magic.solutionsuite.cn` 前端更可靠。

`magic-builder` 依赖 `feishu-signature`：配置它仍然需要 (1) l.garyyang 扫码登录（保存 slot 凭据），以及 (2) 一个单独的 Magic-Builder token 用于发布 FaaS。绕不开 l.garyyang 登录。presence 值始终写入 l.garyyang slot —— hook/更新路径与 provider 无关 —— `magic-builder` 只改变飞书嵌入的是哪个预览 URL。

```bash
# 首次 setup 会跑 l.garyyang 扫码登录（保存 slot 凭据）并提示粘贴 Magic-Builder token。
# 想复用已有登录，可先运行 `agent-presence login --provider feishu-signature`，然后：
agent-presence setup --hook-command absolute
```

在交互式终端且未配置 token 时，setup 会打印 token 获取说明并提示你粘贴，然后存入 OS keyring（macOS Keychain，Linux libsecret）。获取 token：

1. 在飞书中打开妙笔（Magic-Builder）机器人：<https://applink.larkoffice.com/T94fcr4NqQPz>
2. 发送消息 `dev`。
3. 从回复里复制 token。

非交互环境可以不经提示直接提供 token：

```bash
export MAGIC_TOKEN=<token>          # 一次性，优先级最高
# 或 skill-pack 兼容的明文文件（本 CLI 只读取，不写入）：
echo <token> > ~/.magic-token && chmod 600 ~/.magic-token
```

token 解析顺序：`MAGIC_TOKEN` 环境变量 → OS keyring → `~/.magic-token` → `<cwd>/.magic-token`。

`setup` 会构建一个嵌入了 slot id 和 bearer 的 CommonJS FaaS，POST 到 `https://magic.solutionsuite.cn/api/faas`，并把返回的 `record_id` 存到 `providers.magic-builder.faasId`。最终签名 URL 是：

```text
https://magic.solutionsuite.cn/r?fid=<record_id>
```

重新运行 `setup --provider magic-builder` 会原地更新同一个 FaaS（幂等）。hook 仍然像以前一样写入 l.garyyang slot —— 每次飞书刷新预览时 FaaS 从 `/api/slot/info` 拉取（默认缓存 `60s`）。

环境变量 / 配置覆盖：

```bash
export MAGIC_TOKEN=...                                # 发布 token
export AGENT_PRESENCE_MAGIC_BUILDER_BASE_URL=...      # 覆盖 magic.solutionsuite.cn
export AGENT_PRESENCE_MAGIC_BUILDER_FAAS_ID=rec_...   # 固定已有的 FaaS record id
export AGENT_PRESENCE_MAGIC_BUILDER_FAAS_NAME=...     # 覆盖默认的 `agent_presence_preview`
export AGENT_PRESENCE_MAGIC_BUILDER_FALLBACK_TITLE=...# slot 读取失败时渲染
```

token 存在 OS keyring 的 `agent-presence:magic-builder` service 下。发布的 FaaS 嵌入了你的 l.garyyang slot bearer 以便读取 slot 值；轮换该 bearer 需要重新运行 `setup --provider magic-builder` 重新发布。

查看 FaaS 会返回的实时预览：

```bash
agent-presence status --provider magic-builder --remote
# → .remote.faas.title, .remote.faas.expireStrategy
```

### `feishu-signature` provider（slot 后端 + 直连预览备选）

`feishu-signature` 是存储 presence 值的底层 slot 后端；默认的 `magic-builder` 就建立在它之上。直接选用 `feishu-signature`（通过 `--provider feishu-signature`）会跳过 Magic-Builder FaaS，直接从 `l.garyyang.work` 提供预览，无需 Magic-Builder token。当飞书确实能渲染 `l.garyyang.work` 页时可以用它。无论用哪个，presence 值更新都会流向这个 slot 后端。

它当前的 slot 后端是 `l.garyyang.work`：

```http
GET  /api/slot/wechat/qrcode
GET  /api/slot/wechat/login-status?sceneId=...
POST /api/slot/update
GET  /api/slot/info
```

直连预览 URL 只包含编码后的 slot helper，不包含凭据：

```text
https://l.garyyang.work/?t2=<base62({{slot id="slot_xxx"}})>
```

凭据默认存在 macOS Keychain 或 Linux libsecret，也可以用环境变量覆盖：

```bash
export AGENT_PRESENCE_TOKEN=...
export AGENT_PRESENCE_SLOT_ID=slot_xxx
export AGENT_PRESENCE_FEISHU_SIGNATURE_BASE_URL="https://l.garyyang.work"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_BASE_URL="https://l.garyyang.work/"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_IMAGE_KEY="img_xxx"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_TARGET_URL="https://example.com"
```

token 和 slot 凭据不会写入 git、签名 URL 或日志。

## 验证

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
pnpm pack --dry-run

agent-presence status
agent-presence url
agent-presence update --force
agent-presence status --remote

CODEX_THREAD_ID=fake-2 agent-presence hook --source codex --event SessionStart
agent-presence status
CODEX_THREAD_ID=fake-2 agent-presence hook --source codex --event Stop
agent-presence status
```

### Pi Coding Agent 本地验证

`--ignore-scripts` 安装 Pi，然后让 Agent Presence 安装 Pi 集成：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
agent-presence setup --provider feishu-signature --skip-login --hook-command absolute
```

Pi 扩展会写到 `~/.pi/agent/extensions/agent-presence.ts`，`pi` 启动时会自动加载。用真实 LLM 跑通时，从本机文件读取 provider key 注入环境变量，再用 Pi 非交互模式（`-p`）发一条消息，例子里用 Z.ai 的 GLM-5.1：

```bash
export ZAI_API_KEY="$(tr -d '\r\n' < /path/to/your/zai-key.txt)"
pi --provider zai --model glm-5.1 -p "Reply with exactly: pi-ok"

agent-presence status --provider feishu-signature
agent-presence status --provider feishu-signature --remote
```

key 一定要放在仓库外部的本机文件里读取，不要直接写进命令行；只有 `ZAI_API_KEY` 这个环境变量名可以出现在文档/提交记录里，真实 key 值不能进 git、日志、PR 描述、issue。

## 发布

包名是 `@rivus/agent-presence`，仓库使用 Changesets 发布。用户可见变更需要在同一个 PR 里添加 changeset：

```bash
pnpm run changeset
```

发布链路依赖两个设置页面：

1. GitHub 仓库 Settings -> Actions -> General：Workflow permissions 允许读写，并允许 GitHub Actions 创建和批准 PR。Changesets action 需要这个设置来创建或更新 release PR。
2. npm package Settings -> Trusted publishing：为 `@rivus/agent-presence` 配置 GitHub Actions trusted publisher。

npm Trusted Publishing 字段：

```text
GitHub owner: PerfectPan
Repository: agent-presence
Workflow filename: publish.yml
```

`.github/workflows/publish.yml` 只走 Trusted Publishing：workflow 授权 `id-token: write`，不常驻传入 `NPM_TOKEN`。如果新包还不存在，先在常态发布链路之外用短期 npm granular token 做一次 bootstrap publish，例如临时的一次性 workflow 改动，或在干净本地 checkout 里先跑 `pnpm pack --dry-run` 再显式发布。包页面出现后，立刻在 npm package settings 里配置 Trusted Publishing，删除任何临时 workflow/token 改动，并吊销临时 npm token。

`changesets/action` 同时负责创建 release PR 和发布包。发布成功后，它默认会创建对应版本的 GitHub Release，所以仓库的 Releases 页面会出现同一个版本记录。

发布流程：

1. 合并带 `.changeset/*.md` 的功能 PR。
2. `.github/workflows/publish.yml` 创建或更新 `chore: release package` PR。
3. 审核并合并 release PR。
4. `changesets/action` 通过 Changesets 和 npm Trusted Publishing 发布到 npm。
5. 发布成功后，`changesets/action` 创建对应的 GitHub Release。

更多实现边界见 [docs/architecture.md](docs/architecture.md)。可复用的操作员说明见 [skills/agent-presence/SKILL.md](skills/agent-presence/SKILL.md)。
