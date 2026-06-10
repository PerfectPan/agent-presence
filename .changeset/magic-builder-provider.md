---
'@rivus/agent-presence': minor
---

Add `magic-builder` provider as an alternate front-end for the signature URL. `agent-presence setup --provider magic-builder` reads a Magic-Builder token from `MAGIC_TOKEN` / `~/.magic-token`, publishes (or updates) a small CommonJS FaaS to `https://magic.solutionsuite.cn/api/faas`, and emits `https://magic.solutionsuite.cn/r?fid=<record_id>` as the signature URL. Hooks continue to write into the l.garyyang slot exactly as before — the FaaS pulls the current value from `/api/slot/info` each time Feishu refreshes the preview (default cache 60s). Use this when the existing `feishu-signature` URL stops rendering inside Feishu (e.g. the personal-signature iframe whitelist changes).
