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

Usage is a capability of the same source table that drives presence: a source that implements `scanUsage` is billable. All five built-ins are, and a third-party source plugin can be too.

| Source | Token tracking |
| --- | --- |
| Claude Code | yes — priced from the table, deduped, `<synthetic>` excluded |
| Codex | yes — diffs cumulative totals and de-duplicates copied events across session files |
| Pi | yes — uses the cost Pi records |
| opencode | yes — reads the local SQLite store; uses the cost opencode records |
| Gemini CLI | yes — reads the local chat transcripts; priced from the table |

Cost shows `n/a` for models with no pricing entry; token counts are always exact. Pi and opencode log a real cost, so those are used as-is. Other sources are priced from the bundled LiteLLM snapshot for supported models (for example `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `claude-fable-5`, `deepseek-v4-pro`, and `gemini-3-flash-preview`), with a small fallback table for older aliases. Codex fast mode uses the model-specific multiplier, and GPT-5 long-context requests switch the whole request to the higher tier above 272K total prompt input, matching ccusage. Override pricing per model in `~/.agent-presence/config.json` when your deployment uses a private or unlisted model.

## In the signature

Compose your own label with template variables:

```bash
agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d}"
```

`{usage_1d}` is today; `{usage_7d}` (or any `{usage_Nd}`) is N calendar days.
