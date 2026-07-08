---
'@rivus/agent-presence': minor
---

Model every presence source — built-in and third-party — as an entry in one source table, so operators can add, override, or disable a source purely by config. The five built-ins ship as a default table (`sources.default.json`, each referencing its in-code resolver via a `builtin:<id>` handler); a user's `plugins.sources` in `~/.agent-presence/config.json` merges over it by id: a same-id entry overrides a built-in, a new id adds a source, and `enabled: false` disables one. Not writing anything leaves the shipped defaults in effect.

A source resolves via `builtin:<id>` (trusted, raw env), a no-code declarative `match` spec (payload/env field mappings), or a JS `handler` module (npm specifier or absolute path). `agent-presence config show` prints the merged table with each source's origin, kind, and override flag.

A new `agent-presence source add/list/remove` command downloads and registers a source-plugin npm package: `add` runs `npm install` (with `--ignore-scripts`, and a `--registry`/`AGENT_PRESENCE_REGISTRY` override for internal registries) into an isolated plugins dir (`~/.agent-presence/plugins/`), validates the package exports a real source plugin, and records a `plugins.sources` entry; `remove` unregisters and uninstalls it; `uninstall --all` clears the plugins dir. Because it downloads and runs third-party code in the credential-bearing process, `add` prints a trust notice and requires `--yes` or an interactive confirmation.

JS `handler` loading is opt-in and guarded: the handler receives a credential-stripped env, absolute-path handlers must be user-owned, non-symlink, and non-world-writable, `handler` entries are ignored when `config.json` is world-writable, and any load/resolution failure fails open so a source can never break a hook. Trust follows the `builtin:` marker, not the id, so overriding a built-in drops to the guarded path. No behavior change when no `plugins.sources` is configured.
