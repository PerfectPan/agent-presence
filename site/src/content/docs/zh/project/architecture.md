---
title: 架构
description: presence 如何从智能体 hook 流到你的签名。
---

```text
Codex / Claude Code / Gemini CLI / opencode / Pi hooks
-> 本地 presence 状态(加锁 JSON,TTL 清理)
-> 防抖渲染(模板 + usage 徽章)
-> l.garyyang slot(值存储;magic-builder FaaS 在其前面做预览)
-> 飞书签名链接预览
```

整条链路是事件驱动的:hook 在会话边界触发,改写一份加锁的 JSON 状态,防抖渲染器把值推到 slot。不需要 cron 或后台定时器——每次都会扫描整个自然日 usage 窗口,所以单次边界刷新就是完整的。

token 统计是**事后**从本地 transcript 读取的,从不依赖 hook 负载(生命周期事件不带 token 数)。

完整设计与信任边界见仓库里的 `docs/architecture.md`。
