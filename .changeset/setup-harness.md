---
'@rivus/agent-presence': minor
---

Install and uninstall coding-agent hooks through the harness ledger. Setup resolves conflicts before showing the full install plan, requires confirmation before writing agent configuration, applies the accepted plan and verifies the bundle. Non-interactive setup requires `--yes` for a conflict-free plan and never resolves conflicts automatically.

Installed hooks call a stable shim that setup atomically updates to the pinned package version or absolute checkout command. The plan shows expected trust prompts, including Codex approval when the hook command changes. Uninstall reports removed and kept artifacts, then removes the shim, dsh plugin and power watcher; independent cleanup continues if the harness fails. Previous-release hooks outside the ledger still require that release's own uninstall.
