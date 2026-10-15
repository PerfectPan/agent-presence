---
'@rivus/agent-presence': patch
---

An invalid config entry is now ignored with a warning that names it (`config: ignored <path> (...)` on stderr) instead of breaking hooks and commands: the rest of the config still loads, keys the release does not know are kept, and a write command changes only what it is meant to change. Hooks keep reading the config without a schema and fail open on their own source's broken entry; the background worker drops broken entries silently.
