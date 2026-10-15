---
title: Token usage
description: Calendar-day token totals with a dollar estimate.
---

`agent-presence usage` reports token consumption per source, in the spirit of [ccusage](https://github.com/ryoppippi/ccusage): it does not hook the agents, it scans their local transcripts after the fact.

```bash
agent-presence usage            # today + last 7 days
agent-presence usage --days 7   # a single window
agent-presence usage --json     # structured output
```

## Calendar-day windows

Windows are **calendar-day aligned** (since local midnight, inclusive of today). `今日` counts from 00:00 and resets at midnight — it never shrinks mid-day the way a rolling 24h window would.

## Sources

Usage is a capability of the same source table that drives presence: every built-in except `dsh` is decoded from its local transcripts by `@rivus/agent-kit`, and a third-party source plugin can scan its own.

| Source      | Token tracking                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Claude Code | yes — decoded per model request, deduped by request id, `<synthetic>` excluded; priced from the table               |
| Codex       | yes — decoded per model call, each record priced with its rollout's own service tier                                |
| Pi          | yes — uses the cost Pi records                                                                                      |
| opencode    | yes — reads the local SQLite store (legacy JSON store only when no database exists); uses the cost opencode records |
| Gemini CLI  | yes — reads the local chat transcripts under `$GEMINI_CLI_HOME/.gemini/tmp`; priced from the table                  |
| Grok        | yes — decoded per completed turn, with the cost Grok logged                                                         |
| dsh         | yes — the managed dsh plugin reports each model call's usage in real time; priced from the table                    |

Each decoder decides when a record is complete: Claude Code reports a request once four newer requests have been written in its conversation lane or the session has been quiet for 30 minutes, and opencode counts a database message once it completes (a quiet database settles its last running messages). Gemini CLI, Pi, and Codex count a request as soon as its record is complete.

The badge adds its own rule on top: it refreshes at a session boundary's time and, within a day, only that boundary's source. Requests Claude Code still held at the day's last Claude boundary therefore count only at the next Claude boundary more than 30 quiet minutes later — when there is none, they stay out of the badge for the rest of the day. `agent-presence usage` scans to the current time and reports them sooner.

Cost shows `n/a` for models with no pricing entry; token counts are always exact. Pi, opencode, and Grok log a real cost, so those are used as-is. Other sources are priced from the bundled LiteLLM snapshot for supported models (for example `gpt-5.5`, `claude-fable-5`, `deepseek-v4-pro`, and `gemini-3-flash-preview`), with a small fallback table for older aliases. Override pricing per model in `~/.agent-presence/config.json` when your deployment uses a private or unlisted model.

dsh is the one source that does not scrape transcripts: `agent-presence setup` prompts to install a small Cordis plugin into `~/.dsh/plugins/` (registered in the home-level `~/.dsh/cordis.patch.yml`, which applies to every profile). The plugin reports each model call's token usage alongside the presence heartbeat, and `agent-presence` appends it to a local usage log that the `usage` command and signature badge read back. Install or remove it any time with `pnpm run install:dsh-plugin` / `pnpm run uninstall:dsh-plugin` (or `node dist/scripts/install-dsh-plugin.js`).

## In the signature

Compose your own label with template variables:

```bash
agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d}"
```

`{usage_1d}` is today; `{usage_7d}` (or any `{usage_Nd}`) is N calendar days.
