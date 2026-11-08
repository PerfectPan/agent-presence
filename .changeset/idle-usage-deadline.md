---
'@rivus/agent-presence': minor
---

The slot sync computes the deadline of the value it publishes — the earliest local midnight at which a usage badge in it turns stale — and saves it with the published value, ready for a transport to the generated preview; the deadline survives state reloads and follows local calendar midnights across DST. Only badges actually displayed contribute a deadline, and equal text from a newly refreshed day updates its deadline. No remote-reset transport ships yet. The fallback title a generated preview shows when it cannot read the slot now drops the `{usage*}` tokens instead of leaking a raw token.
