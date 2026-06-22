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

## Provider

CLI 命令通过一个小的注册表(`createProvider`)解析 provider,只断言自己需要的能力——登录、发布、或签名 URL——因此从不依赖某个具体后端。共享的远端值存储抽象成 `SlotBackend`:`magic-builder`(默认)和 `feishu-signature` 都**组合**同一个后端来做登录/发布/读取,只在飞书嵌入哪个预览 URL 上分叉。两个 provider 互不依赖;未来一个有自己存储的新 provider,可以直接实现该接口而完全不碰 slot 后端。

完整设计与信任边界见仓库里的 `docs/architecture.md`。
