---
'@rivus/agent-presence': patch
---

Refresh all built-in usage sources at the first session boundary after midnight, or when the aggregate cache has not been initialized, so inactive sources contribute zero instead of leaving the signature stuck at `今日 —`. Keep failed scans retryable and prevent slower overlapping refreshes from overwriting newer usage.
