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
agent-presence setup --agents claude-code,codex  # override detection
agent-presence setup --hook-command package  # default; npx is an alias
agent-presence setup --hook-command absolute # use the checkout CLI
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

`setup` detects `claude-code`, `codex`, `gemini-cli`, `grok`, `opencode` and `pi`, and installs hooks only for agents reported as `found` or `runnable`. It checks commands on `PATH` or the existence of agent-owned session/state stores and credential files without running agent commands or reading credential contents. An agent home alone, presence hooks/plugins, shared settings and MCP configuration do not count. See [Agent detection](/guide/install/#agent-detection) for the evidence paths. Missing agents receive an install-and-rerun message. An `unknown` result names the checks that failed and suggests `--agents`.

`--agents <id,...>` overrides detection with a comma-separated list of those six kit ids. A desktop-app-only installation whose CLI has never run and is absent from `PATH` requires this override. Unknown ids and kit ids without presence support are rejected. Hooks for agents omitted by detection or `--agents` stay unchanged. When the harness ledger has entries owned by `agent-presence` for those agents, setup names them and shows `agent-presence setup --agents <id,...>` to update them. `agent-presence uninstall` removes presence hooks for all agents. With no detected agents and no override, setup skips the agent install plan, confirmation, apply and verification. It still prepares the shim for the selected `--hook-command` mode: `package` installs or reuses the pinned runtime, while `absolute` uses the checkout CLI. Only after preparation succeeds does setup continue with the watcher, dsh and provider steps.

Before queue recovery or login, `setup` checks all six agents for previous-release entries and files kept from an earlier removal, regardless of detection or `--agents`. It lists these entries, including files installed by this version, and refuses until they are moved or removed; see [Upgrading](/guide/install/#upgrade-from-090-or-earlier). Replacement entries require the uninstall for each distinct pinned hook version, plus `0.9.0` whenever any replacement entry is not a pinned hook command. Kept files require manual handling before those uninstalls. It then lists each configuration conflict's locator, reason and allowed resolutions, re-plans with your choices and displays the full plan for confirmation. A target with no allowed resolution, such as a dotfiles-managed or symlinked target, stops setup. Canceling or declining confirmation discards any held plan and exits non-zero without writing agent configuration; local migration and login may already have completed.

A non-interactive terminal requires `--yes` to apply a conflict-free plan; conflicts cause setup to exit with or without `--yes`. An interactive terminal always requires explicit confirmation. After confirmation, setup installs or reuses the runtime in default `package` mode, writes the stable hook shim, applies the plan and immediately verifies the kit artifacts selected for this run. A runtime install failure cleans up the temporary directory, discards the plan and exits non-zero before shim or agent-target writes. It then runs the power-watcher step, automatically rewrites an existing marker-identified presence dsh plugin to use the shim without prompting (including with `--yes` or in a non-interactive terminal), or offers a fresh installation only in an interactive terminal with dsh detected, and sets up the provider; canceling the dsh prompt or a provider failure does not skip the verification results. If reading the dsh plugin to inspect its marker fails, setup prints one note, skips dsh work and continues provider setup and runtime pruning. `--no-hooks` skips the previous-release check, harness, runtime installation, shim, dsh and watcher, without inspecting or rewriting the dsh plugin; `--skip-login` (also `--hooks-only`) skips login. `--hook-command package` is the default, with `npx` accepted as its alias. Setup uses npm to install its exact published version under `~/.agent-presence/runtime/<version>/`; npm and registry access are only needed during that installation. The shim directly runs the installed CLI with setup's Node executable, falling back to `node` on `PATH` if that file disappears. `--hook-command absolute` uses the checkout's CLI and installs no runtime. Both modes keep the command installed in the agent unchanged; hook execution never runs `npx`. `AGENT_PRESENCE_HOOK_COMMAND` accepts the same modes. Invalid modes exit with a one-line error naming the allowed modes before install planning. The error names `--hook-command` for an explicit flag, or `AGENT_PRESENCE_HOOK_COMMAND` for an environment value.

Successful setup prunes under the runtime lock, retaining its own version and the versions selected by the previous shim and the shim at cleanup time; unused versions and leftover `runtime/.install-*` directories are removed. dsh and the macOS power watcher also call the shim. Upgrading from 0.10.0 only requires installing this release and running `setup`; the installed commands stay unchanged, with no uninstall or additional hook re-trust cycle. See [Upgrading from 0.10.0](/guide/install/#upgrade-from-0100).

Installed locations are listed in [Install](/guide/install/#installed-locations): Claude Code uses a plugin rather than the settings file Cursor also reads, Gemini uses an extension with its own event names, Codex uses a plugin or `config.toml`, Grok has its own hook file, and opencode/Pi use bridges. Claude Code, Codex, Gemini CLI and Grok command hooks have a five-second timeout in their native units. The opencode/Pi bridges bound only synchronous finish delivery to five seconds; other events are asynchronous without a child-process timeout. The move to the shim's `hook --agent` command is expected to require one Codex hook re-trust cycle; later shim-only updates preserve the hook definition. Real-agent acceptance remains separate from isolated install checks.

Hook commands are installed automatically by `setup` and never block the agent. See [Sources](/guide/sources/) for adding, overriding, or disabling the counted agents.

```bash
agent-presence hook --agent <claude-code|codex|gemini-cli|grok|opencode|pi>
agent-presence hook --source <id> --event <name> [--silent]
```

Setup installs the `--agent` form, which reads the agent's native hook payload. Direct calls use `--source` with `claude`, `codex`, `gemini`, `grok`, `dsh`, or a configured source; `--event` takes an internal event name such as `SessionStart`, `Heartbeat`, or `Stop`. opencode and Pi use their `--agent` bridges.

`doctor` prints each harness check with its status and exits non-zero for any warning or error. It checks all six supported agents, including agents no longer detected. Duplicate detection covers command-hook files, not opencode and Pi bridge files, and uses presence-specific previous-release markers plus the current harness command. Old absolute-path commands from checkout paths without a presence marker remain undetectable; see [Upgrading](/guide/install/#upgrade-from-090-or-earlier). It does not repair agent configuration, though checking the ledger lock may create lock files in the harness state directory. `doctor` also reports `stale-path`, `unknown-event` and `timeout-unit` problems in other tools' hooks and exits 1 for them.

`inventory` prints the harness ledger revision, installed entries and pending operations. Both commands accept `--json`. Artifacts installed by setup through the harness appear in this ledger; hooks installed by previous releases are not automatically recorded. `inventory` includes every kit application's entries in the shared ledger, not only presence's.

`uninstall` covers all six supported agents, including agents no longer detected. It removes only ledger-recorded artifacts, reports every removal and kept locator with its reason, then removes the shim, the whole `~/.agent-presence/runtime/` directory, dsh plugin and macOS watcher. A harness failure still allows these independent removals to run and leaves a non-zero exit code; previous-release artifacts require that release's own uninstall. Credentials, configuration and state are kept by default. `--credentials` removes credentials and slot identifiers from config; `--all` also removes session state, queued records and installed source plugins, keeping the queue tombstone that prevents old processes from restoring state. Other configuration keys are preserved.
