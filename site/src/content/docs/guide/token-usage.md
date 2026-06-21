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

| Source | Token tracking |
| --- | --- |
| Claude Code | yes — priced from the table, deduped, `<synthetic>` excluded |
| Codex | yes — diffs the cumulative session total |
| Pi | yes — uses the cost Pi records |
| Gemini CLI | presence only — no local per-message token log |

Cost shows `n/a` for models with no pricing entry; token counts are always exact. Override pricing per model in `~/.agent-presence/config.json`.

## In the signature

Compose your own label with template variables:

```bash
agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d}"
```

`{usage_1d}` is today; `{usage_7d}` (or any `{usage_Nd}`) is N calendar days.
