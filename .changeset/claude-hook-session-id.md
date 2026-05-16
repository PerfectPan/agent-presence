---
"@rivus/agent-presence": patch
---

Improve Claude hook session detection from transcript paths, add redacted hook diagnostics for troubleshooting missing session ids, log each slot update attempt/result without storing rendered signature text, and schedule a deferred flush when a rendered update is debounced or rate-limited.
