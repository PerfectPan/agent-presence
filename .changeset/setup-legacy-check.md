---
'@rivus/agent-presence': patch
---

Upgrading from 0.9.0 or earlier: run the previous release's own uninstall first, then install this release and run `agent-presence setup`. Setup refuses while entries an earlier release installed remain, lists them, and names the command to run: `npx --yes @rivus/agent-presence@<version> uninstall` for each version a listed hook command pins, and `0.9.0` for entries that pin none (bridge files, opencode config references); from a checkout, `node <checkout>/dist/src/cli.js uninstall`. Run it without `--credentials` or `--all` to keep credentials, configuration and state, and with any old install-target override variables still set (this release ignores them and warns when they are set). Files kept from an earlier removal are listed too and must be moved or removed by hand first, because the old uninstall would delete them.

Absolute-path commands from a checkout path that carries no presence marker cannot be detected; check those agents' configuration after the uninstall. The old uninstall also removes another tool's Claude, Codex or Gemini hook whose command contains `dist/src/cli.js hook`; restore such entries afterwards if you need them. `doctor` reports a previous release's command hook left next to the new one. Moving to the stable shim's `hook --agent` command asks for one Codex hook review; later upgrades only rewrite the shim.
