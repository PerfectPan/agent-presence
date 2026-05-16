---
"@rivus/agent-presence": minor
---

Add Linux platform support:
- Hook installers, status, update, reset, url, and config commands now work on Linux
- Credentials stored via secret-tool (libsecret) with env var fallback; plaintext config fallback is rejected with a clear error message
- Power watcher skipped on Linux (TTL pruning covers expired sessions); RFC documents the rationale
- Credential storage abstracted behind a `CredentialBackend` interface (`KeychainBackend` / `SecretToolBackend`)
- CI runs on both macOS and Linux with OS-specific integration tests
