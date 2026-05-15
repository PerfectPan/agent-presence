---
"@rivus/agent-presence": patch
---

Introduce a `PresenceProvider` interface and registry. CLI commands now resolve providers through `createProvider(id, { baseUrl, credential })` instead of instantiating the Feishu signature backend directly, and each command asserts the capability it needs (`login`, `updateSlot`, `getInfo`, `buildSignatureUrl`). Behavior and configuration for the existing `feishu-signature` provider are unchanged.
