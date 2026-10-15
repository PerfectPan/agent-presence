---
title: Commands
description: The agent-presence command surface.
---

Bare commands target the default `magic-builder` provider. Add `--provider feishu-signature` for the direct preview.

```bash
agent-presence setup                 # install hooks + link signature
agent-presence setup --login         # force a fresh QR login
agent-presence setup --skip-login    # skip login, keep hook and provider setup
agent-presence setup --no-hooks
agent-presence setup --hook-command absolute
agent-presence setup --yes           # apply a conflict-free plan without a TTY

agent-presence url                   # print the signature URL
agent-presence status                # what would render now
agent-presence status --remote       # what the live signature serves
agent-presence update --force        # push a render immediately
agent-presence reset --force         # clear the signature

agent-presence usage                 # today + last 7 days
agent-presence usage --days 7
agent-presence usage --json

agent-presence doctor                # check harness hooks and ledger
agent-presence doctor --json
agent-presence inventory             # ledger revision, entries and pending operations
agent-presence inventory --json

agent-presence config show
agent-presence config render --zero "..." --one "..." --many "..."

agent-presence source list                       # every counted source + its origin
agent-presence source add <npm-package> --yes     # install & register a source plugin
agent-presence source add <pkg> --registry <url> --id <id>
agent-presence source remove <id>                 # unregister + uninstall the package

agent-presence uninstall             # remove hooks (keeps credentials)
agent-presence uninstall --credentials
agent-presence uninstall --all
```

Before queue recovery or login, `setup` lists detected previous-release entries and files kept from an earlier removal, including files installed by this version, and refuses until they are moved or removed; see [Upgrading](/guide/install/#upgrade-from-090-or-earlier). Replacement entries require the uninstall for each distinct pinned hook version, plus `0.9.0` whenever any replacement entry is not a pinned hook command. Kept files require manual handling before those uninstalls. It then lists each configuration conflict's locator, reason and allowed resolutions, re-plans with your choices and displays the full plan for confirmation. A target with no allowed resolution, such as a dotfiles-managed or symlinked target, stops setup. Canceling or declining confirmation discards any held plan and exits non-zero without writing agent configuration; local migration and login may already have completed.

A non-interactive terminal requires `--yes` to apply a conflict-free plan; conflicts cause setup to exit with or without `--yes`. An interactive terminal always requires explicit confirmation. After confirmation, setup writes the stable hook shim, applies the plan and immediately verifies the kit artifacts. It then runs the dsh and power-watcher steps and sets up the provider; canceling the dsh prompt or a provider failure does not skip the verification results. `--no-hooks` skips the previous-release check, harness, shim, dsh and watcher; `--skip-login` (also `--hooks-only`) skips login. `--hook-command absolute` changes only the program the shim runs, leaving the command installed in the agent unchanged.

Installed locations are listed in [Install](/guide/install/#installed-locations): Claude Code uses a plugin rather than the settings file Cursor also reads, Gemini uses an extension with its own event names, Codex uses a plugin or `config.toml`, Grok has its own hook file, and opencode/Pi use bridges. Claude Code, Codex, Gemini CLI and Grok command hooks have a five-second timeout in their native units. The opencode/Pi bridges bound only synchronous finish delivery to five seconds; other events are asynchronous without a child-process timeout. The move to the shim's `hook --agent` command is expected to require one Codex hook re-trust cycle; later shim-only updates preserve the hook definition. Real-agent acceptance remains separate from isolated install checks.

Hook commands are installed automatically by `setup` and never block the agent. See [Sources](/guide/sources/) for adding, overriding, or disabling the counted agents.

`doctor` prints each harness check with its status and exits non-zero for any warning or error. It checks Claude Code, Codex, Gemini CLI, Grok, opencode and Pi. Duplicate detection covers command-hook files, not opencode and Pi bridge files, and uses presence-specific previous-release markers plus the current harness command. Old absolute-path commands from checkout paths without a presence marker remain undetectable; see [Upgrading](/guide/install/#upgrade-from-090-or-earlier). It does not repair agent configuration, though checking the ledger lock may create lock files in the harness state directory. A presence home path containing spaces can currently cause a false missing-program warning. `doctor` also reports `stale-path`, `unknown-event` and `timeout-unit` problems in other tools' hooks and exits 1 for them.

`inventory` prints the harness ledger revision, installed entries and pending operations. Both commands accept `--json`. Artifacts installed by setup through the harness appear in this ledger; hooks installed by previous releases are not automatically recorded. `inventory` includes every kit application's entries in the shared ledger, not only presence's.

`uninstall` removes only ledger-recorded artifacts, reports every removal and kept locator with its reason, then removes the shim, dsh plugin and macOS watcher. A harness failure still allows these independent removals to run and leaves a non-zero exit code; previous-release artifacts require that release's own uninstall. Credentials, configuration and state are kept by default. `--credentials` removes credentials and slot identifiers from config; `--all` also removes session state, queued records and installed source plugins, keeping the queue tombstone that prevents old processes from restoring state. Other configuration keys are preserved.
