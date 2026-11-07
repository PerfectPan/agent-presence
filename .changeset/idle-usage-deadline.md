---
'@rivus/agent-presence': minor
---

The slot sync computes the deadline of the value it publishes — the earliest local midnight at which a usage badge in it turns stale — and saves it with the published value, ready for a transport to the generated preview; no transport ships yet, so behavior is unchanged. The fallback title a generated preview shows when it cannot read the slot now drops the `{usage*}` tokens instead of leaking a raw token.
