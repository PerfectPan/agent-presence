---
'@rivus/agent-presence': patch
---

Keep deferred slot delivery cache-only so agent hooks cannot trigger a cross-source usage rescan. Preserve cached usage badges when macOS power events reset active sessions, and reject cross-midnight source snapshot mixtures.
