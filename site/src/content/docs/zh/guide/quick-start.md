---
title: 快速上手
description: 两条命令,让签名实时显示你的 AI 牛马。
---

## 1. 安装配置

```bash
agent-presence setup
```

按提示扫码、粘贴 Magic-Builder token,让 setup 装好各智能体的 hook。

## 2. 拿到签名 URL

```bash
agent-presence url
```

把这个 URL 粘贴到 **飞书 → 个人信息 → 签名** 的自定义链接预览里。

## 3. 干活

启动任意编码智能体,徽章会在会话边界自动更新——无 cron、无常驻进程。

```text
3 个 AI 牛马正在并行搬砖 | claude 2 · codex 1 | 今日 171M · $260
```

## 随时查看状态

```bash
agent-presence status            # 现在会渲染成什么
agent-presence status --remote   # 线上签名实际是什么
agent-presence usage             # 今日 + 近 7 天 token 消耗
```
