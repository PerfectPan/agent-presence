---
title: 命令
description: agent-presence 命令一览。
---

不带 `--provider` 的命令指向默认的 `magic-builder`;加 `--provider feishu-signature` 走直连预览。

```bash
agent-presence setup                 # 安装 hook + 链接签名
agent-presence setup --login         # 强制重新扫码登录
agent-presence setup --skip-login    # 只刷新 hook
agent-presence setup --no-hooks
agent-presence setup --hook-command absolute

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
agent-presence uninstall --all
```

hook 命令由 `setup` 自动安装,且永不阻塞智能体。添加、覆盖或禁用被统计的智能体见 [Sources](/zh/guide/sources/)。

`doctor` 逐项打印 harness 检查及其状态，任何警告或错误都会使退出码非零。检查范围包括 Claude Code、Codex、Gemini CLI、Grok、opencode 和 Pi。重复检测覆盖命令式 hook 文件，不覆盖 opencode 和 Pi 桥接文件；它识别当前 harness 命令，暂不识别旧版本命令。它不会修复智能体配置，但检查安装记录锁时可能在 harness 状态目录中创建锁文件。presence home 路径含空格时，目前可能误报程序不存在。 `doctor` 也会报告其他工具 hook 中的 `stale-path`、`unknown-event` 和 `timeout-unit` 问题，并以退出码 1 结束。

`inventory` 打印 harness 安装记录的修订号、已安装条目和待完成操作。两个命令都支持 `--json`。当前 `setup` 仍使用原有安装器，其安装结果不会出现在 harness 记录中，因此空记录不代表没有安装 presence hook。 `inventory` 包含共享安装记录中所有 kit 应用的条目，不限于 presence。
