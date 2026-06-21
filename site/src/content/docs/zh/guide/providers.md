---
title: Provider
description: magic-builder(默认)与 feishu-signature(直连)。
---

两个 provider 读的是**同一个** l.garyyang slot。slot 值的更新始终写到这个后端;provider 只决定飞书嵌入哪个预览 URL。

## `magic-builder` — 默认

`magic.solutionsuite.cn` 上的一个预览函数。飞书每次拉取链接预览时,它在服务端运行、读取当前 slot 值并作为标题返回。设为默认是因为:即使飞书不渲染直连页,它也能可靠渲染这个前端。

它依赖 `feishu-signature`:配置仍需要扫码登录(保存 slot 凭据)**以及**一个单独的 Magic-Builder token 来发布该函数。

```bash
agent-presence setup            # 默认 provider
agent-presence url              # https://magic.solutionsuite.cn/r?fid=...
```

## `feishu-signature` — 直连备选

直接从 `l.garyyang.work` 提供预览,**无需** Magic-Builder token。当飞书能正常渲染该页时可用它。

```bash
agent-presence setup --provider feishu-signature
agent-presence url --provider feishu-signature
```

已有安装不受默认变更影响:`login` 会把显式 provider 写进配置,默认只对全新安装生效。
