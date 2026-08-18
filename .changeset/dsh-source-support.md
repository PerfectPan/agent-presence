---
"@rivus/agent-presence": minor
---

Add dsh (DeepSeek harness) as a built-in source. `agent-presence setup` prompts to install a managed Cordis plugin into `~/.dsh/plugins/` (registered in the home-level `~/.dsh/cordis.patch.yml`, which applies to every profile). The plugin bridges dsh lifecycle events to presence (`agent/session-start` → running, `agent/pre-step` / `tools/*` → heartbeat, `agent/turn-stopping` → finished) and reports each model call's token usage in real time via the hook payload, which `agent-presence` appends to a local usage log. The `usage` command and signature badge read that log back, so dsh contributes to the same calendar-day windows and totals as the transcript-scraping sources — without scraping dsh's zstd transcripts. Install or remove any time with `pnpm run install:dsh-plugin` / `pnpm run uninstall:dsh-plugin`.
