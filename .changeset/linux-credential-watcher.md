---
"@rivus/agent-presence": minor
---

Add Linux platform support with libsecret credential storage. Hook installers, status, update, reset, url, and config commands now work on Linux. Credentials are stored via secret-tool (libsecret) with environment variable fallback; plaintext fallback is rejected. Power watcher is skipped on Linux (TTL pruning covers expired sessions).
