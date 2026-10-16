---
title: Quick start
description: From install to a live Feishu signature in two commands.
---

## 1. Set up

```bash
agent-presence setup
```

Scan the QR code if prompted, then review setup's install plan and confirm before it writes agent configuration. After verification, paste a Magic-Builder token when prompted. In a non-interactive terminal, `setup --yes` applies only a conflict-free plan; interactive setup always asks for confirmation.

If you use 0.9.0 or earlier, follow the [upgrade procedure](/guide/install/#upgrade-from-090-or-earlier) before replacing the package.

## 2. Get your signature URL

```bash
agent-presence url
```

Paste that URL into **Feishu → profile → signature** as a custom link preview.

## 3. Work

Start any coding agent. Hooks queue lifecycle events; a background worker updates the badge and exits after five idle minutes.

```text
3 个 AI 牛马正在并行搬砖 | claude 2 · codex 1 | 今日 171M · $260
```

## Check status anytime

```bash
agent-presence status            # what would render now
agent-presence status --remote   # what the live signature serves
agent-presence usage             # today + last 7 days token spend
```
