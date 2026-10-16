---
title: 快速上手
description: 两条命令,让签名实时显示你的 AI 牛马。
---

## 1. 安装配置

```bash
agent-presence setup
```

按提示扫码，然后查看 setup 的安装计划；setup 获得确认后才写入智能体配置。验证通过后，按提示粘贴 Magic-Builder token。非交互终端可用 `setup --yes` 应用无冲突计划；交互终端始终会请求确认。

已使用 0.9.0 或更早版本的用户，请先按[升级指引](/zh/guide/install/#从-090-或更早版本升级)操作，再替换安装的包。

## 2. 拿到签名 URL

```bash
agent-presence url
```

把这个 URL 粘贴到 **飞书 → 个人信息 → 签名** 的自定义链接预览里。

## 3. 干活

启动任意编码智能体。hook 将生命周期事件写入队列，后台 worker 更新徽章，空闲五分钟后退出。

```text
3 个 AI 牛马正在并行搬砖 | claude 2 · codex 1 | 今日 171M · $260
```

## 随时查看状态

```bash
agent-presence status            # 现在会渲染成什么
agent-presence status --remote   # 线上签名实际是什么
agent-presence usage             # 今日 + 近 7 天 token 消耗
```
