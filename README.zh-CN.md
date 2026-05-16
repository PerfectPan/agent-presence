# Agent Presence 中文说明

[English](README.md)

Agent Presence 会把本机编码智能体的生命周期事件同步到飞书个性签名的链接预览里。

```text
Codex / Claude Code / Gemini CLI / opencode hooks
-> 本地 presence 状态
-> 防抖渲染
-> l.garyyang slot provider
-> 飞书签名链接预览
```

`@rivus/agent-presence` 的核心是 presence，而不是飞书专用逻辑。当前第一个输出目标是通过 `l.garyyang.work` 更新飞书签名预览；hook、状态、渲染和 provider 的分层以后可以继续扩展。

## 安装

Agent Presence 当前支持 macOS 和 Linux。CLI 和安装脚本会检测不支持的平台并给出明确错误；Windows 暂不支持。

macOS 使用 Keychain 存凭据，并安装 LaunchAgent 电源 watcher。Linux 使用 `secret-tool` / libsecret 存凭据；由于 systemd user service 和 logind 信号在不同发行版上不够稳定，Linux 会跳过电源 watcher，依赖 TTL 清理过期 session。

从包仓库全局安装：

```bash
pnpm add -g @rivus/agent-presence
agent-presence setup --provider feishu-signature
```

不全局安装，直接使用发布包：

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --provider feishu-signature
```

如果智能体环境启动 hook 时 `PATH` 很窄，用绝对路径安装 hook：

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --provider feishu-signature --hook-command absolute
```

Codex 可能要求你在 Codex 设置中批准更新后的 hook。`setup` 会安装 hook 并打印提醒，但不会直接修改 Codex 的信任状态。

本地仓库开发安装：

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup --provider feishu-signature
```

包里也暴露了兼容命令 `agent-signature`，旧 hook 可以继续工作，新安装默认使用 `agent-presence`。

## 使用流程

1. 运行 `agent-presence setup --provider feishu-signature`。
2. 如果需要登录，扫码完成授权。
3. 让 setup 安装 Codex、Claude Code、Gemini CLI、opencode hook，以及当前平台支持的 watcher。
4. 运行 `agent-presence url --provider feishu-signature`。
5. 把输出 URL 粘贴到飞书个人资料签名的自定义链接预览中。

`setup` 会把凭据放在 macOS Keychain、Linux libsecret，或显式环境变量中，不会把凭据写进飞书签名 URL。本地配置、状态、日志和未来托管运行时默认在 `~/.agent-presence/`。

## 常用命令

```bash
agent-presence login --provider feishu-signature
agent-presence setup --provider feishu-signature
agent-presence setup --provider feishu-signature --login
agent-presence setup --provider feishu-signature --skip-login
agent-presence setup --provider feishu-signature --no-hooks
agent-presence setup --provider feishu-signature --hook-command absolute
agent-presence uninstall
agent-presence uninstall --credentials
agent-presence uninstall --all
agent-presence url --provider feishu-signature
agent-presence status --provider feishu-signature
agent-presence status --provider feishu-signature --remote
agent-presence update --provider feishu-signature --force
agent-presence reset --provider feishu-signature --force
agent-presence config show
agent-presence config provider feishu-signature --base-url "https://l.garyyang.work" --preview-base-url "https://l.garyyang.work/" --image-key "img_xxx" --target-url "https://example.com"
agent-presence config render --zero "AI 牛马下班了" --one "{total} 个 AI 牛马正在搬砖 | {details}" --many "{total} 个 AI 牛马并行搬砖 | {details}"
```

hook 会由 `setup` 自动安装，也可以直接调用：

```bash
agent-presence hook --source codex --event SessionStart
agent-presence hook --source claude --event SessionStart --silent
agent-presence hook --source gemini --event SessionStart --silent
agent-presence hook --source opencode --event SessionStart --silent
agent-presence hook --source codex --event Stop
```

hook 不会阻塞编码智能体。Codex hook 输出 `{}`；Claude、Gemini 和 opencode hook 静默运行。

## Presence 语义

这里统计的是“正在工作的智能体”，不是“打开了多少个终端窗口”。

```text
SessionStart / UserPromptSubmit / PreToolUse / PostToolUse -> running / heartbeat
Stop / SessionEnd / session.idle                              -> finished
3 分钟无 heartbeat                                             -> 过期
睡眠 / 合盖 / 屏幕睡眠                                         -> 重置为 0
唤醒                                                          -> 再次重置为 0
```

默认渲染：

```text
0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z
```

渲染结果最长 200 个字符。

## Hook 和 Watcher

`agent-presence setup` 会安装：

- `~/.codex/hooks.json` 里的 Codex hooks
- `~/.claude/settings.json` 里的 Claude Code hooks
- `~/.gemini/settings.json` 里的 Gemini CLI hooks
- `~/.config/opencode/plugins/agent-presence.js` 里的 opencode plugin
- macOS LaunchAgent power watcher；Linux 会跳过 watcher，并依赖 TTL 清理过期 session

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

当前 provider id 是 `feishu-signature`，slot 后端是 `l.garyyang.work`：

```http
GET  /api/slot/wechat/qrcode
GET  /api/slot/wechat/login-status?sceneId=...
POST /api/slot/update
GET  /api/slot/info
```

URL 只包含编码后的 slot helper，不包含凭据：

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
