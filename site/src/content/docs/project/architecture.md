---
title: Architecture
description: How presence flows from agent hooks to your signature.
---

```text
Codex / Claude Code / Gemini CLI / opencode / Pi hooks
-> local presence state (lock-guarded JSON, TTL pruning)
-> debounced renderer (templates + usage badges)
-> l.garyyang slot  (value storage; magic-builder FaaS fronts it for the preview)
-> Feishu signature link preview
```

The pipeline is event-driven: hooks fire on session boundaries, mutate a lock-guarded JSON state, and a debounced renderer pushes the value to the slot. No cron or background timer is required — each refresh scans the whole calendar-day usage window, so a single boundary refresh is complete.

Token usage is read **after the fact** from local agent transcripts, never from hook payloads (lifecycle events do not carry token counts).

For the full design and trust boundaries, see `docs/architecture.md` in the repository.
