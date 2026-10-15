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
agent-presence setup --hook-command absolute
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

`setup` 在队列恢复和登录前列出检测到的旧版本项目，并拒绝继续，直到这些项目被移除，见[升级指引](/zh/guide/install/#从-090-或更早版本升级)。随后列出每个配置冲突的位置、原因和允许的处理方式，按你的选择重新规划，展示完整计划后请求确认。没有可选处理方式的目标（如 dotfiles 管理或符号链接目标）会使 setup 退出。取消或拒绝确认会丢弃已有计划并以非零退出码结束，不写入智能体配置；本地迁移和登录可能已完成。

非交互终端必须传 `--yes` 才会应用无冲突的计划；有冲突时无论是否传 `--yes` 都会退出。交互终端始终需要明确确认。确认后 setup 写入稳定的 hook shim、应用计划、运行 dsh 和电源 watcher 步骤、设置 provider，最后验证 bundle。`--no-hooks` 跳过旧版本检查、harness、shim、dsh 和 watcher；`--skip-login`（也可用 `--hooks-only`）跳过登录。`--hook-command absolute` 只改变 shim 调用的程序，安装到智能体中的命令保持不变。

完整路径见[安装位置](/zh/guide/install/#安装位置)：Claude Code 使用插件，避免写入 Cursor 也会读取的 settings 文件；Gemini 使用扩展及其原生事件名；Codex 使用插件或 `config.toml`；Grok 使用独立 hook 文件；opencode/Pi 使用桥接文件。Claude Code、Codex、Gemini CLI 和 Grok 的命令式 hook 按各自的原生单位设置五秒超时。opencode/Pi 桥接仅对同步结束事件的交付设置五秒超时，其他事件异步发送，不设置子进程超时。切换到 shim 的 `hook --agent` 命令预计需要在 Codex 中重新信任一次 hook，后续只更新 shim 时会保留 hook 定义。真实智能体验收与隔离环境中的安装检查分开进行。

hook 命令由 `setup` 自动安装,且永不阻塞智能体。添加、覆盖或禁用被统计的智能体见 [Sources](/zh/guide/sources/)。

`doctor` 逐项打印 harness 检查及其状态，任何警告或错误都会使退出码非零。检查范围包括 Claude Code、Codex、Gemini CLI、Grok、opencode 和 Pi。重复检测覆盖命令式 hook 文件，不覆盖 opencode 和 Pi 桥接文件；同时使用 presence 专属的旧版本标记和当前 harness 命令。checkout 路径不含 presence 标记的旧绝对路径命令仍无法识别，见[升级指引](/zh/guide/install/#从-090-或更早版本升级)。它不会修复智能体配置，但检查安装记录锁时可能在 harness 状态目录中创建锁文件。presence home 路径含空格时，目前可能误报程序不存在。`doctor` 也会报告其他工具 hook 中的 `stale-path`、`unknown-event` 和 `timeout-unit` 问题，并以退出码 1 结束。

`inventory` 打印 harness 安装记录的修订号、已安装条目和待完成操作。两个命令都支持 `--json`。setup 通过 harness 安装的产物会出现在记录中；旧版本安装的 hook 不会自动记入记录。`inventory` 包含共享安装记录中所有 kit 应用的条目，不限于 presence。

`uninstall` 只移除 harness 记录的产物，逐项报告移除结果和保留位置及原因，然后移除 shim、dsh 插件和 macOS watcher。harness 失败时仍会继续这些独立清理步骤，并以非零退出码结束；旧版本留下的产物需要用该版本的 uninstall 移除。默认保留凭据、配置和状态；`--credentials` 清除凭据及配置中的 slot 标识，`--all` 还会清除 session 状态、队列记录和已安装的源插件，同时保留防止旧进程恢复状态的队列 tombstone。其他配置字段会保留。
