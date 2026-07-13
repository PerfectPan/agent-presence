# RFC: Token Usage Statistics

## Status

Accepted

## Problem

The presence pipeline tells you *which* agents are working, but not *how much*
they have consumed. Users want a per-day view of token spend across their local
coding agents — comparable to [`ccusage`](https://github.com/ryoppippi/ccusage)
for Claude Code — and they want today's number reflected in the same Feishu
signature that already shows live presence.

## Goals

- A CLI command that reports token usage over calendar-day windows (default
  today and the last 7 days), per source, with an estimated USD cost.
- Coverage of every source that records usage locally: Claude, Codex, Pi. (Since
  extended to opencode and Gemini, and generalised into a `scanUsage` capability
  on the source table — see [`source-usage.md`](./source-usage.md).)
- Optionally surface today's usage in the signature, reusing the existing render
  pipeline rather than a second update path.
- Pricing that can be corrected per deployment without a code change.

## Non-Goals

- ~~Gemini accounting. The Gemini CLI does not persist per-message token usage
  locally, so it cannot be derived; it is reported as "not tracked".~~
  **Superseded.** Current Gemini CLI *does* persist per-turn token usage in its
  local chat transcripts (`~/.gemini/tmp/<hash>/chats/`), so it is now tracked
  (priced from the table, like Codex). See [`source-usage.md`](./source-usage.md).
- Real-time per-event metering. Usage is computed by scanning transcripts after
  the fact (the same approach as ccusage), not from hook payloads — hook events
  do not carry token counts.
- Cross-machine aggregation or historical charts.

## Proposed Design

A new `src/usage/` module, independent of the presence hook path:

- `read-jsonl.ts` — recursively list `*.jsonl` under a root, skipping files whose
  mtime predates the window, and parse them line by line (tolerant of malformed
  lines).
- `scan-claude.ts` / `scan-codex.ts` / `scan-pi.ts` — extract per-entry usage
  records, filtered to the calendar-day window
  `[startOfLocalDay(now) - (days-1)*24h, now)`:
  - Claude: de-duplicate by `message.id` + `requestId`, keeping the final
    (largest) occurrence — streaming rewrites a turn with growing
    `output_tokens`, so keeping the first under-counts output. Exclude
    `<synthetic>` turns. (Cross-checked against `ccusage`: matches to within
    live-write noise; an earlier keep-first version under-counted output ~3.8%.)
  - Codex: prefer each real event's `last_token_usage`, falling back to a
    saturating diff of `total_token_usage` for older logs. Forked/subagent
    sessions replay the parent's token history in one timestamp second; detect
    that prefix from `forked_from_id` / `thread_spawn`, skip it while retaining
    its cumulative baseline, then count only the child's new events. Scan both
    `sessions/` and `archived_sessions/`. Split cached input out of input.
  - Pi: trust the cost Pi already records in the transcript (display mode).
- `pricing.ts` — best-effort USD-per-MTok table matched by model substring
  (longest match wins), overridable via `config.usage.pricing`. Unknown models
  yield `null` cost while keeping exact token counts.
- `index.ts` — `collectWindowUsage({ days, now, pricing, roots })` aggregates all
  sources into per-source and total figures.

Surfaces:

- `agent-presence usage [--days N] [--json]` prints a 1d/7d table (or a single
  window) and a machine-readable JSON form.
- The signature reuses `renderPresence` via template variables, so consumers
  compose their own label and pick windows: `{usage}` (the default window),
  `{usage_1d}`, `{usage_7d}`, and generically `{usage_Nd}`. Badges are cached
  per-window in state (`state.usageBadges`, keyed by day count) and substituted
  by `prepareSlotSync`. Usage is active when a template references any `{usage*}`
  token, or when `usage.showInSignature` is set (zero-config auto-append of the
  default window, labelled `今日`/`近N天`). The hook path refreshes the cache via
  `refreshSignatureUsageBadges` **only on session-boundary events**
  (`isSessionBoundaryEvent`: start/finish, excluding subagent boundaries),
  scanning each referenced window; other events reuse the cache and do no
  scanning. Because each scan reads the whole calendar-day window, a single
  boundary refresh is always complete — no background timer or cron is needed.
  A cached badge whose window has fully rolled over (`今日` after one local
  midnight, `近N天` after N days) renders as `—` at display time rather than
  showing a number from a stale day.

## Alternatives Considered

- **Read token counts from hook payloads.** Rejected: lifecycle events do not
  carry usage; only the transcripts do.
- **Rolling 24h windows.** Originally shipped, then replaced: a rolling
  `[now-24h, now)` window makes `今日` *decrease* mid-day as old activity ages out,
  which reads as a bug for a label meaning "today". Calendar-day windows (snapped
  to local midnight, ccusage `daily` style) only grow within a day and reset at
  00:00.
- **Bundle a live pricing feed (LiteLLM).** Deferred: a static, overridable table
  avoids a network dependency on the hot path; users correct drift via config.

## Rollout Plan

- Ship behind an opt-in flag for the signature badge; the CLI command is always
  available and read-only.
- Document sources, cost derivation, and pricing override in `README.md`.

## Risks

- **Pricing drift.** Defaults will go stale; mitigated by per-model overrides and
  an explicit `n/a` for unpriced models (tokens stay exact).
- **Scan cost on large transcript stores.** Mitigated by the mtime pre-filter and
  by refreshing the signature badge only at session boundaries (not per event);
  the standalone command accepts the full scan.
- **Mid-session staleness.** The signature badge reflects the total as of the
  last session boundary, not the live in-progress count. Accepted: the standalone
  `usage` command always rescans for an exact current figure.
- **Format changes upstream.** Each scanner is tolerant of missing fields and
  malformed lines, so a format change degrades to fewer records, never a crash.

## Follow-ups / TODO

- **Reset the signature usage tail at midnight (time-aware preview).** When the
  machine is idle or off nothing re-renders, so a cached badge outlives its
  window — yesterday's `今日` total lingers the next day. Preferred approach: the
  magic-builder FaaS already executes on every Feishu preview fetch, independent
  of the laptop, so make it time-aware. The writer stores the slot value plus a
  "usage valid until" epoch (the next local midnight, Asia/Shanghai, resolved to
  an absolute epoch on the writer where the timezone is known) in a spare
  metadata slot; the FaaS returns the full title while `now < validUntil` and a
  plain idle line (`AI 牛马正在摸鱼中`) afterwards. No cron, no credential
  migration, works with the laptop off, resets within one `expire_strategy`
  interval of midnight. Note: `/api/slot/info` returns only `{id, value}` (no
  timestamp), so the validity signal must travel in slot data — it cannot be
  derived remotely. Alternative: a dedicated scheduled writer (on-platform FaaS
  timer if supported, else GitHub Actions / Cloudflare cron) POSTing the idle
  string at 00:00 — simpler logic but copies the slot bearer off-machine and only
  fires on schedule. Open: confirm whether the magic-builder/miaoda FaaS platform
  exposes a scheduled trigger at all; the code only wires HTTP triggers.

- **~~Reconsider `今日` semantics: rolling-24h vs calendar-day.~~ Done.** Adopted
  calendar-day windows for all spans (snapped to local midnight, inclusive of
  today): `今日` no longer decreases mid-day and resets at 00:00. This partly
  addresses the reset follow-up — the window itself zeroes at midnight, though a
  *cached* badge still needs the time-aware preview (or a recompute) to reflect
  that while the machine is idle.
