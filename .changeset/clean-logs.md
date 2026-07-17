---
"@rivus/agent-presence": patch
---

Bound diagnostic log growth by compacting logs larger than 5 MiB to their latest roughly 1 MiB, including the macOS power watcher log. Existing macOS users should rerun `agent-presence setup --skip-login` once after upgrading to refresh the persistent watcher files.
