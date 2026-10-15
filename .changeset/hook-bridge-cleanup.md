---
'@rivus/agent-presence': patch
---

`hook --source opencode` and `hook --source pi` no longer read the payloads of the bridges that releases before this one installed; configured sources reusing `builtin:opencode` or `builtin:pi` follow the same shipped resolver rule. Raw `session.created`, `session.deleted`, `session.error`, and `session.idle` events now count as heartbeats in direct `hook --source <any> --event <raw name>` calls and configured `match` sources resolving those names.
