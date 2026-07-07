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
