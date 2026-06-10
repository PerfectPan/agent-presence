---
'@rivus/agent-presence': minor
---

Add `magic-builder` provider as an alternate front-end for the signature URL. `agent-presence setup --provider magic-builder` publishes (or updates) a small CommonJS FaaS to `https://magic.solutionsuite.cn/api/faas` and emits `https://magic.solutionsuite.cn/r?fid=<record_id>` as the signature URL. Hooks continue to write into the l.garyyang slot exactly as before — the FaaS pulls the current value from `/api/slot/info` each time Feishu refreshes the preview (default cache 60s). Use this when the existing `feishu-signature` URL stops rendering inside Feishu (e.g. the personal-signature iframe whitelist changes).

In an interactive terminal, setup prints the token-acquisition steps (open the 妙笔 Feishu bot, send `dev`, copy the reply) and prompts for the token, then stores it in the OS keyring (Keychain / libsecret) under `agent-presence:magic-builder`. Token resolution order is `MAGIC_TOKEN` env → keyring → `~/.magic-token` → `<cwd>/.magic-token`; the plaintext file is still read for skill-pack compatibility but is no longer written by this CLI.
