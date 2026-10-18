---
'@rivus/agent-presence': minor
---

Setup no longer refuses to run when an installation from 0.9.0 or earlier is still present. To upgrade from 0.9.0 or earlier, first run that release's uninstall (`npx --yes @rivus/agent-presence@0.9.0 uninstall`, or `node <checkout>/dist/src/cli.js uninstall` for a checkout); if you skip it, both versions' hooks fire and `agent-presence doctor` reports the duplicates.

Credentials stored only under the Keychain service used before the rename, and files in the old `~/.codex/agent-signature` home, are no longer migrated or read. If `agent-presence status` reports `hasToken: false` after upgrading, log in again with `agent-presence login`.
