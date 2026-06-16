---
"@rivus/agent-presence": patch
---

Token usage windows are now calendar-day aligned instead of rolling 24h. `今日`
counts from local midnight (and resets at 00:00) rather than sliding as a
`[now-24h, now)` window — which previously made the figure *decrease* mid-day as
old activity aged out. A window of N days spans N local calendar days inclusive
of today.

Also: a cached signature badge whose window has fully rolled over since it was
computed (one midnight for `今日`, N days for `近N天`) now renders as `—` instead
of a stale number, until the next session-boundary refresh recomputes it. The
template label is preserved.
