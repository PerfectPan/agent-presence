---
'@rivus/agent-presence': patch
---

Before upgrading from 0.9.0 or earlier, first move any previously kept files out of the old install locations, or remove them if unwanted, even when replacement entries are also listed. Then use the previous release's own `agent-presence uninstall` for the remaining old installation without `--credentials` or `--all`, install this release and run setup. Use `npx --yes @rivus/agent-presence@<previous-version> uninstall` for each version pinned in the old hooks, or `0.9.0` when none is pinned; a checkout install can use `node <checkout>/dist/src/cli.js uninstall` before updating it. Keep old install-target override variables set for that uninstall; this release ignores them and warns when set. The current uninstall removes only ledger-recorded agent artifacts.

Setup now lists detected previous-release entries and refuses before queue recovery, login or install confirmation. Previously kept files must be moved or removed by hand, as must renamed or hand-edited remnants the old uninstall leaves. Old absolute-path commands from checkout paths without a presence marker can escape detection; inspect their configuration after cleanup. The old uninstall can also remove another tool's Claude/Codex/Gemini hook containing `dist/src/cli.js hook`, so preserve and restore those entries if needed. Doctor now detects marker-carrying previous-release command hooks beside the new hooks.

Moving to the stable shim's `hook --agent` command is expected to require one Codex hook re-trust cycle. Later shim-only upgrades keep the installed hook definition stable and need no previous-release uninstall.
