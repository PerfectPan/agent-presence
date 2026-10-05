---
'@rivus/agent-presence': patch
---

Update the interactive prompt library `@clack/prompts` from 1.3.0 to 1.8.1, which `login`, `setup`, `config` and `source add` use. Since clack 1.6, `note()` no longer dims its content, so the boxed hints in an interactive terminal (the login QR code, the signature URL and Magic-Builder token help in `setup`, the `source add` trust notice) render at full brightness instead of dimmed.
