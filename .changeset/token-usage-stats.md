---
"@rivus/agent-presence": minor
---

Add `agent-presence usage` for rolling-window token consumption (ccusage-style).
Scans Claude, Codex, and Pi transcripts after the fact (Gemini does not persist
local token usage), reports tokens and an estimated USD cost per source over
configurable windows (default: last 1d and 7d). The signature can show usage via
render-template variables `{usage}` / `{usage_1d}` / `{usage_7d}` / `{usage_Nd}`
(compose your own label), or `usage.showInSignature` for a zero-config badge;
badges refresh only on session boundaries. Pricing is overridable per model in
`config.usage.pricing`.
