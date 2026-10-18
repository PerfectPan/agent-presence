---
'@rivus/agent-presence': minor
---

Setup no longer refuses to run when an installation from 0.9.0 or earlier is still present. To upgrade from 0.9.0 or earlier, first run that release's uninstall (`npx --yes @rivus/agent-presence@0.9.0 uninstall`, or `node <checkout>/dist/src/cli.js uninstall` for a checkout); it also removes what earlier releases installed. If you skip it, Claude Code, Codex and Gemini CLI run both versions' hooks and `agent-presence doctor` reports the duplicates: run the 0.9.0 uninstall, then run `agent-presence setup` again, because the old uninstall can delete the current opencode bridge. opencode and Pi bridges instead show up in setup as `unmanaged-exists` conflicts: cancel there and run the 0.9.0 uninstall. Do not choose `adopt` or `backup`; `backup` keeps the old bridge, and a later `agent-presence uninstall` restores it.

Credentials stored only under the Keychain service used before the rename, and files in the old `~/.codex/agent-signature` home, are no longer migrated or read. If `agent-presence status` reports `hasToken: false` after upgrading, log in again with `agent-presence login`. `uninstall --credentials` no longer deletes that old Keychain entry (service `agent-signature-slot-credential`); on macOS, remove it with `security delete-generic-password -s agent-signature-slot-credential -a "$USER"`.
