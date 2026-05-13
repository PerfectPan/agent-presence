---
"@rivus/agent-presence": patch
---

Fix Codex stop events that report an unstable session id by finishing the latest matching running session instead of leaving the active count unchanged.
