---
"@rivus/agent-presence": minor
---

Add `agent-presence usage` for rolling-window token consumption (ccusage-style).
Scans Claude, Codex, and Pi transcripts after the fact (Gemini does not persist
local token usage), reports tokens and an estimated USD cost per source over
configurable windows (default: last 1d and 7d), and can optionally append a
`今日 <tokens> · <cost>` badge to the signature via `usage.showInSignature`.
Pricing is overridable per model in `config.usage.pricing`.
