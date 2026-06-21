---
title: Quick start
description: From install to a live Feishu signature in two commands.
---

## 1. Set up

```bash
agent-presence setup
```

Scan the QR code if prompted, paste a Magic-Builder token, and let setup install the agent hooks.

## 2. Get your signature URL

```bash
agent-presence url
```

Paste that URL into **Feishu → profile → signature** as a custom link preview.

## 3. Work

Start any coding agent. The badge updates on session boundaries — no cron, no daemon.

```text
3 个 AI 牛马正在并行搬砖 | claude 2 · codex 1 | 今日 171M · $260
```

## Check status anytime

```bash
agent-presence status            # what would render now
agent-presence status --remote   # what the live signature serves
agent-presence usage             # today + last 7 days token spend
```
