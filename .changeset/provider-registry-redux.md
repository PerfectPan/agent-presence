---
"@rivus/agent-presence": patch
---

Introduce a `PresenceProvider` interface and provider registry so CLI commands resolve providers through `createProvider(id, …)` and assert the capability each command needs, instead of importing `LGaryYangProvider` directly. Both shipped providers (`feishu-signature` and `magic-builder`) are registered; `magic-builder` composes the same slot backend for login/update/info and only overrides the signature URL and remote preview. No user-facing behavior change.
