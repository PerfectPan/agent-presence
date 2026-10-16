---
title: 架构
description: presence 如何从智能体 hook 流到你的签名。
---

```text
Codex / Claude Code / Gemini CLI / opencode / Pi / Grok hooks
-> hook 将事件写入本地队列并返回
-> worker 在状态锁下将队列事件应用到 JSON 状态(TTL 清理)
-> usage 刷新 + 防抖渲染(模板 + usage 徽章)
-> l.garyyang slot(值存储;magic-builder FaaS 在其前面做预览)
-> 飞书签名链接预览
```

整条链路由事件驱动：hook 将事件写入本地队列后返回。worker 在状态锁下将队列事件应用到 JSON 状态，在会话边界刷新 usage，再通过防抖渲染器发布。空闲五分钟后，worker 退出。

token 统计是**事后**从本地 transcript 读取的。托管 dsh 插件是例外：其 hook 负载携带每次模型调用的 usage，由 worker 追加到本地日志，再由 usage 扫描器读取。

`setup` 通过 kit harness 规划变更，在写入智能体配置前请求确认，将产物记入安装记录并验证；`uninstall` 移除这些已记录的产物。`doctor` 检查安装健康状态，`inventory` 展示共享的安装记录。管理位置见[安装指南](/zh/guide/install/#安装位置)。

## Provider

CLI 命令通过一个小的注册表(`createProvider`)解析 provider,只断言自己需要的能力——登录、发布、或签名 URL——因此从不依赖某个具体后端。共享的远端值存储抽象成 `SlotBackend`:`magic-builder`(默认)和 `feishu-signature` 都**组合**同一个后端来做登录/发布/读取,只在飞书嵌入哪个预览 URL 上分叉。两个 provider 互不依赖;未来一个有自己存储的新 provider,可以直接实现该接口而完全不碰 slot 后端。

完整设计与信任边界见仓库里的 `docs/architecture.md`。

## Sources

哪些智能体贡献 presence,由一张**源表(source table)**决定。七个内置源作为默认表随包发布(每个通过 `builtin:<id>` handler 引用一个代码内解析器);用户配置里的 `plugins.sources` 按 id 合并覆盖其上——同 id 覆盖内置,新 id 新增,`enabled: false` 禁用。一个源可通过 `builtin:<id>`(可信、原始环境变量)、零代码的声明式 `match` 规则、或一个 JS `handler` 模块来解析。`agent-presence source add` 会把源插件 npm 包装进一个独立的 plugins 目录并注册;handler 在进程内带护栏运行(剥离凭据的环境、路径/配置属主校验)且 fail-open,坏掉的源永远不会阻塞 hook。见 [Sources 指南](/zh/guide/sources/)。
