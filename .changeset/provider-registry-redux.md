---
"@rivus/agent-presence": patch
---

Introduce a `PresenceProvider` interface and provider registry so CLI commands resolve providers through `createProvider(id, …)` and assert the capability each command needs (`assertSupportsLogin` / `assertSupportsPublish` / `assertSupportsSignatureUrl`), instead of importing the storage backend directly.

The shared remote value store is modelled explicitly as a `SlotBackend` (`LGaryYangSlotBackend`): both `feishu-signature` and `magic-builder` compose the same backend for login/publish/info and differ only in the signature URL (and magic-builder's remote preview), so neither provider depends on the other. The capability layer uses a generic `publishValue` (not `updateSlot`) so a future provider with its own storage can implement `PresenceProvider` without a slot backend. No user-facing behavior change.
