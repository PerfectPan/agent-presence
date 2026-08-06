---
title: Provider
description: magic-builder(默认)与 feishu-signature(直连)。
---

两个 provider 读的是**同一个**托管 slot。slot 值的更新始终写到这个后端;provider 只决定飞书嵌入哪个预览 URL。

## `magic-builder` — 默认

`magic.solutionsuite.cn` 上的一个预览函数。飞书每次拉取链接预览时,它在服务端运行、读取当前 slot 值并作为标题返回。设为默认是因为:即使飞书不渲染直连页,它也能可靠渲染这个前端。

它依赖 `feishu-signature`:配置仍需要扫码登录(保存 slot 凭据)**以及**一个单独的 Magic-Builder token 来发布该函数。

```bash
agent-presence setup            # 默认 provider
agent-presence url              # https://magic.solutionsuite.cn/r?fid=...
```

## `feishu-signature` — 直连备选(遗留)

直接用 slot host 自带的页面提供预览,**无需** Magic-Builder token。飞书可能已经不再渲染个性签名的这个直连页,这条路径可能会悄悄变成什么都不显示——除非你确认飞书还能渲染该页,否则优先用 `magic-builder`。

```bash
agent-presence setup --provider feishu-signature
agent-presence url --provider feishu-signature
```

已有安装若保存了遗留 provider,显式指定 provider 的命令仍可继续使用。直接执行 `setup` 和 `url` 时现在默认走 `magic-builder`;确实需要直连预览时再传 `--provider feishu-signature`。
