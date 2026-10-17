---
title: 命令
description: agent-presence 命令一览。
---

不带 `--provider` 的命令指向默认的 `magic-builder`;加 `--provider feishu-signature` 走直连预览。

```bash
agent-presence setup                 # 安装 hook + 链接签名
agent-presence setup --login         # 强制重新扫码登录
agent-presence setup --skip-login    # 跳过登录，保留 hook 和 provider 设置步骤
agent-presence setup --no-hooks
agent-presence setup --agents claude-code,codex  # 覆盖检测结果
agent-presence setup --hook-command package  # 默认模式；npx 是其别名
agent-presence setup --hook-command absolute # 使用 checkout 的 CLI
agent-presence setup --yes           # 非交互终端应用无冲突的安装计划

agent-presence url                   # 打印签名 URL
agent-presence status                # 现在会渲染成什么
agent-presence status --remote       # 线上签名实际是什么
agent-presence update --force        # 立即推送一次
agent-presence reset --force         # 清空签名

agent-presence usage                 # 今日 + 近 7 天
agent-presence usage --days 7
agent-presence usage --json

agent-presence doctor                # 检查 harness hook 和安装记录
agent-presence doctor --json
agent-presence inventory             # 记录修订号、已安装条目和待完成操作
agent-presence inventory --json

agent-presence config show
agent-presence config render --zero "..." --one "..." --many "..."

agent-presence source list                       # 列出所有被统计的源及其来源
agent-presence source add <npm-package> --yes     # 安装并注册一个源插件
agent-presence source add <pkg> --registry <url> --id <id>
agent-presence source remove <id>                 # 反注册并卸载该包

agent-presence uninstall             # 移除 hook(保留凭据)
agent-presence uninstall --credentials
agent-presence uninstall --all
```

`setup` 检测 `claude-code`、`codex`、`gemini-cli`、`grok`、`opencode` 和 `pi`，只为状态为 `found` 或 `runnable` 的智能体安装 hook。检测检查 `PATH` 中的命令，或智能体自身的会话、状态存储和凭据文件是否存在，不运行智能体命令，也不读取凭据内容。智能体 home 目录本身、presence hook 或插件、共享 settings、MCP 配置都不算证据，完整路径见[智能体检测](/zh/guide/install/#智能体检测)。未找到智能体时会提示先安装、再运行 setup；`unknown` 结果会列出失败的检查并提示使用 `--agents`。

`--agents <id,...>` 接收逗号分隔的上述六个 kit id，覆盖检测结果。仅安装桌面应用、从未运行 CLI 且命令不在 `PATH` 中时，需要此参数。未知 id 和 presence 不支持的 kit id 会被拒绝。未被检测选中或未列入 `--agents` 的智能体，其 hook 保持不变。只有 harness 安装记录中存在属于 `agent-presence` 的未选中智能体条目时，setup 才会列出这些智能体，并提示用 `agent-presence setup --agents <id,...>` 更新它们。`agent-presence uninstall` 会移除所有智能体的 presence hook。没有检测到智能体且未覆盖选择时，setup 跳过智能体安装计划、确认、应用和校验，但仍按所选 `--hook-command` 模式准备 shim：`package` 安装或复用固定版本 runtime，`absolute` 使用 checkout 的 CLI。准备成功后才继续 watcher、dsh 和 provider 步骤。

`setup` 在队列恢复和登录前检查全部六个智能体的旧版本项目和此前卸载时保留的文件，不受检测结果或 `--agents` 影响。它列出这些项目（也可能由本版本安装），并拒绝继续，直到这些项目被移走或移除，见[升级指引](/zh/guide/install/#从-090-或更早版本升级)。需要替换的项目应对每个固定的 hook 版本分别卸载；只要有一个需要替换的项目不是固定版本的 hook 命令，就额外运行 `0.9.0`。运行这些卸载命令前，先手动处理保留文件。随后列出每个配置冲突的位置、原因和允许的处理方式，按你的选择重新规划，展示完整计划后请求确认。没有可选处理方式的目标（如 dotfiles 管理或符号链接目标）会使 setup 退出。取消或拒绝确认会丢弃已有计划并以非零退出码结束，不写入智能体配置；本地迁移和登录可能已完成。

非交互终端必须传 `--yes` 才会应用无冲突的计划；有冲突时无论是否传 `--yes` 都会退出。交互终端始终需要明确确认。确认后 setup 在默认 `package` 模式下安装或复用 runtime，再写入稳定的 hook shim、应用计划并立即验证本次选中的 kit 产物。runtime 安装失败时，setup 清理临时目录、丢弃计划，并在写入 shim 或智能体目标前以非零状态退出；验证成功后，再依次运行电源 watcher 步骤、将已有且带 presence 标记的 dsh 插件自动重写为调用 shim（无需询问，包括 `--yes` 或非交互终端），或仅在交互终端检测到 dsh 时询问是否首次安装，并设置 provider；取消 dsh 提示或 provider 失败不会跳过验证结果。如果无法读取 dsh 插件来检查标记，setup 只显示一条提示，跳过 dsh 操作，继续 provider 设置和 runtime 清理。`--no-hooks` 跳过旧版本检查、harness、runtime 安装、shim、dsh 和 watcher，既不检查也不重写 dsh 插件；`--skip-login`（也可用 `--hooks-only`）跳过登录。`--hook-command package` 是默认模式，`npx` 保留为它的别名。setup 用 npm 将自身的固定发布版本安装到 `~/.agent-presence/runtime/<version>/`；仅安装时需要 npm 和 registry 访问。shim 直接用 setup 当时的 Node 可执行文件运行已安装的 CLI，该文件消失时回退到 `PATH` 中的 `node`。`--hook-command absolute` 使用 checkout 的 CLI，不安装 runtime。两种模式安装到智能体中的命令相同，hook 执行从不调用 `npx`。`AGENT_PRESENCE_HOOK_COMMAND` 接受相同的模式。无效模式会在安装规划前以单行错误退出，列出允许的模式。错误按值的来源命名：显式参数为 `--hook-command`，环境变量为 `AGENT_PRESENCE_HOOK_COMMAND`。

setup 成功后在 runtime 锁内清理，保留本次版本、旧 shim 指向的版本和清理时 shim 指向的版本，删除其他版本及残留的 `runtime/.install-*` 目录。dsh 和 macOS 电源 watcher 也通过 shim 调用。从 0.10.0 升级只需安装本版本并运行 `setup`；已安装的命令保持不变，无需先卸载，也不会增加 hook 重新信任流程。见[从 0.10.0 升级](/zh/guide/install/#从-0100-升级)。

完整路径见[安装位置](/zh/guide/install/#安装位置)：Claude Code 使用插件，避免写入 Cursor 也会读取的 settings 文件；Gemini 使用扩展及其原生事件名；Codex 使用插件或 `config.toml`；Grok 使用独立 hook 文件；opencode/Pi 使用桥接文件。Claude Code、Codex、Gemini CLI 和 Grok 的命令式 hook 按各自的原生单位设置五秒超时。opencode/Pi 桥接仅对同步结束事件的交付设置五秒超时，其他事件异步发送，不设置子进程超时。切换到 shim 的 `hook --agent` 命令预计需要在 Codex 中重新信任一次 hook，后续只更新 shim 时会保留 hook 定义。真实智能体验收与隔离环境中的安装检查分开进行。

hook 命令由 `setup` 自动安装,且永不阻塞智能体。添加、覆盖或禁用被统计的智能体见 [Sources](/zh/guide/sources/)。

```bash
agent-presence hook --agent <claude-code|codex|gemini-cli|grok|opencode|pi>
agent-presence hook --source <id> --event <name> [--silent]
```

setup 安装 `--agent` 形式，读取智能体的原生 hook payload。直接调用使用 `--source`，支持 `claude`、`codex`、`gemini`、`grok`、`dsh` 和配置中的源；`--event` 接收 `SessionStart`、`Heartbeat`、`Stop` 等内部事件名。opencode 和 Pi 使用各自的 `--agent` 桥接。

`doctor` 逐项打印 harness 检查及其状态，任何警告或错误都会使退出码非零。检查范围包括全部六个受支持的智能体，即使它们已无法被检测到。重复检测覆盖命令式 hook 文件，不覆盖 opencode 和 Pi 桥接文件；同时使用 presence 专属的旧版本标记和当前 harness 命令。checkout 路径不含 presence 标记的旧绝对路径命令仍无法识别，见[升级指引](/zh/guide/install/#从-090-或更早版本升级)。它不会修复智能体配置，但检查安装记录锁时可能在 harness 状态目录中创建锁文件。presence home 路径含空格时，目前可能误报程序不存在。`doctor` 也会报告其他工具 hook 中的 `stale-path`、`unknown-event` 和 `timeout-unit` 问题，并以退出码 1 结束。

`inventory` 打印 harness 安装记录的修订号、已安装条目和待完成操作。两个命令都支持 `--json`。setup 通过 harness 安装的产物会出现在记录中；旧版本安装的 hook 不会自动记入记录。`inventory` 包含共享安装记录中所有 kit 应用的条目，不限于 presence。

`uninstall` 覆盖全部六个受支持的智能体，包括已无法检测到的智能体。它只移除 harness 记录的产物，逐项报告移除结果和保留位置及原因，然后移除 shim、整个 `~/.agent-presence/runtime/` 目录、dsh 插件和 macOS watcher。harness 失败时仍会继续这些独立清理步骤，并以非零退出码结束；旧版本留下的产物需要用该版本的 uninstall 移除。默认保留凭据、配置和状态；`--credentials` 清除凭据及配置中的 slot 标识，`--all` 还会清除 session 状态、队列记录和已安装的源插件，同时保留防止旧进程恢复状态的队列 tombstone。其他配置字段会保留。
