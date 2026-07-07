---
'@rivus/agent-presence': minor
---

Unify all presence sources behind one `SourcePlugin` interface and registry, and let additional coding agents be onboarded without a core change or a new release. The five built-in sources (codex/claude/gemini/opencode/pi) are now registered statically through the same interface instead of a hardcoded dispatch. Configure `plugins.sources` in `~/.agent-presence/config.json` to add more, with either a no-code declarative `match` spec (payload/env field mappings) or a JS `handler` module that resolves a source's hook context. Built-in sources always take precedence, and `agent-presence config show` now lists every registered source with its origin.

Config `handler` loading is opt-in and guarded: the handler receives a credential-stripped env, absolute-path handlers must be user-owned, non-symlink, and non-world-writable, `handler` entries are ignored when `config.json` is world-writable, and any load/resolution failure fails open so a config source can never break a hook. No behavior change when no `plugins` key is configured.
