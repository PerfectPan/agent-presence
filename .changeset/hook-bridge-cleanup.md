---
'@rivus/agent-presence': patch
---

`hook --source opencode` and `hook --source pi` no longer read the payloads of the bridges that releases before this one installed; configured sources reusing `builtin:opencode` or `builtin:pi` follow the same shipped resolver rule.
