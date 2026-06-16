---
"@rivus/agent-presence": minor
---

Make `magic-builder` the default provider. Feishu's link-preview pipeline does
not reliably render the direct `l.garyyang.work` page, while the
`magic.solutionsuite.cn` FaaS front-end is accepted — so a bare
`agent-presence setup` / `url` / `status` now targets magic-builder. Slot value
updates still flow to the l.garyyang backend (the push path is provider-agnostic),
and `feishu-signature` remains fully supported as the underlying slot backend and
a direct-preview alternative via `--provider feishu-signature`.

Existing installs are unaffected: `login` persists an explicit `provider` in
config, so the new default only applies to fresh setups. New users will be
prompted for a Magic-Builder token during setup (the direct `feishu-signature`
preview needs no token).
