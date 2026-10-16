---
'@rivus/agent-presence': minor
---

Install and uninstall coding-agent hooks through the harness ledger. Setup resolves conflicts before showing the full install plan, requires confirmation before writing agent configuration, applies the accepted plan and immediately verifies the kit artifacts before the watcher, dsh and provider steps. Non-interactive setup requires `--yes` for a conflict-free plan and never resolves conflicts automatically.

Use Claude Code's plugin location instead of the shared settings file Cursor also reads, Gemini's extension with its native event names, Codex's plugin or `config.toml`, Grok's own hook file, and kit-generated opencode/Pi bridges. Set five-second timeouts in the native units of Claude Code, Codex, Gemini CLI and Grok command hooks, correcting the old Claude Code and Codex timeouts of 5000 seconds and the old Claude-style Gemini registrations. The opencode/Pi bridges limit synchronous finish delivery to five seconds; other events are sent asynchronously without a child-process timeout.

Installed hooks call a stable shim that setup atomically updates to the pinned package version or absolute checkout command. Switching to its `hook --agent` command is expected to require one Codex hook re-trust cycle; later shim-only updates keep the installed command stable. Real-agent acceptance remains separate from the isolated installation checks.

Uninstall reports removed and kept artifacts, then removes the shim, dsh plugin and power watcher; independent cleanup continues if the harness fails. Credentials, configuration and state are preserved by default. Previous-release hooks outside the ledger are not removed by this version; use that release's own uninstall before upgrading, following the upgrade guidance. Remove the superseded per-agent hook install/uninstall scripts and their aggregate commands; keep the dsh and watcher scripts.
