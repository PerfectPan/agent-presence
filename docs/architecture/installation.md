# Setup, Upgrades, And Uninstall

How `setup`, upgrades, downgrades, installed agent artifacts, Codex hook trust, and `uninstall` manage hooks through the harness ledger. For the system overview, stable hook shim, and failure model, see [overview.md](overview.md).

## Setup And Idempotency

`src/cli/commands/setup.ts` coordinates first-run setup in this order:

1. Validate the hook-command mode during argument parsing, before planning; invalid values exit with a one-line error listing `package`, `npx` and `absolute`. The error names `--hook-command` when that flag supplied the value, or `AGENT_PRESENCE_HOOK_COMMAND` when the value came from the environment.
2. Clear any queue tombstone under takeover: delete queued records, increase the epoch, and remove the tombstone. Load configuration and log in when credentials are missing, unless `--skip-login` or `--hooks-only` is passed. `--login` forces fresh authentication unless login is skipped.
3. Unless `--no-hooks` is passed, select detected agents or the validated `--agents` override and call `planInstall` for those agents. With an empty detected selection, skip the agent plan, confirmation, apply and verification, but still prepare the selected hook-command mode and shim before the watcher, dsh and provider steps; a runtime preparation failure stops setup before those steps. The kit reports conflicts before returning a full plan. Display every conflicting locator, reason and allowed choices; prompt once per locator for one of those choices or cancel, then re-plan with the selected choices. Newly reported locators repeat this process. A target with no allowed choice, including dotfiles-managed or symlinked targets, stops setup without writing an agent target.
4. Display the plan as readable lines: file actions and paths (grouping configuration entry names per file), command lines, agent trust questions, reasons for kept files and dropped hooks, and selected conflict resolutions. Entry removals use `(remove)` or `(restore)` when the pre-install value will return; no-op, kept and released entries are excluded. Dropped hooks name the agent running another agent's registration and that registration's event and file. Agent names come from the kit catalog. Paths under the home directory or its canonical symlink target use `~`, including when the home has a trailing slash; file contents are omitted, empty sections say `none`, and TTY and non-TTY previews use the same text. Ask for explicit confirmation in a TTY. Outside a TTY, a conflict-free plan requires `--yes`; every conflict is refused even with `--yes`. Cancellation or declining confirmation discards any held plan, reports that no agent configuration was written, and exits non-zero.
5. Read the previous shim's runtime. In default `package` mode, install or reuse the pinned runtime. If installation fails, clean its temporary directory, discard the plan and exit non-zero before shim or agent-target writes. Write the stable shim; when agents are selected, apply the same in-memory plan handle and report each artifact result. `PlanStale` or `TargetChanged` stops setup with instructions to run it again; setup does not retry application.
6. When agents are selected, immediately verify the installed bundle with `verify("agent-presence", { bundle, agents })`. Verification checks only kit artifacts; supplying the bundle also finds a desired artifact missing from both disk and ledger. The install harness program ends here, so a later canceled dsh prompt or provider failure cannot skip verification or turn that failure into a harness error dump.
7. After successful verification, or after runtime and shim preparation when no agent is selected, install the macOS power watcher through its existing script. Linux prints the watcher skip message and relies on TTL pruning. Then rewrite an existing presence dsh plugin identified by its marker without prompting; only a fresh installation is offered when dsh is detected in an interactive terminal. Publish or resolve the provider's signature URL. On successful setup, prune under the runtime lock, retaining this setup's version, the previous shim's version and the version the shim selects at prune time, and remove leftover `runtime/.install-*` directories. A reported provider error does not skip pruning. Installing the watcher before the dsh prompt keeps it installed if that prompt is canceled. These presence-managed steps run outside Effect with their existing error handling and messages.

`--no-hooks` skips the harness, runtime installation, shim, dsh update or install, and watcher. Queue recovery, login and provider setup retain their behavior. Credential writes may happen before install confirmation; the confirmation protects agent-target installation writes. Harness planning can settle pending ledger operations.

`src/setup.ts` runs only the watcher installer, and its uninstall list contains only dsh and the watcher. The hand-written Claude/Codex/Gemini hook writers and opencode/Pi bridge writers, their per-agent scripts, and the aggregate hook-install scripts are removed; a generator of the agent artifacts 0.9.0's setup wrote lives only in `test/fixtures/previous-release.ts`, for the downgrade test. The dsh plugin and watcher invoke the stable shim; their standalone checkout installers create an absolute-mode shim only when no shim exists.

| Area              | Idempotency rule                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider login    | Reuse the existing credential and configured slot; force or skip login only when requested.                                                                                                                                                       |
| Config            | Merge provider/render settings without deleting unrelated keys.                                                                                                                                                                                   |
| Harness artifacts | Compare the bundle, ledger and targets; require allowed conflict resolutions and confirmation before applying changes, and preserve unrelated settings and comments.                                                                              |
| Package runtime   | Reuse a matching package manifest and existing CLI; install into a temporary sibling and rename on success; retain the setup version and the previous/current shim versions, and remove leftover `.install-*` directories under the runtime lock. |
| Hook shim         | Atomically replace the same executable file on each confirmed setup; switching command modes changes its contents, not the installed hook command.                                                                                                |
| Power watcher     | On macOS, replace the managed LaunchAgent plist and script, then reload the same label. On Linux, skip with a message.                                                                                                                            |
| State             | Preserve session state during setup. A tombstoned queue is cleared before hooks are enabled again.                                                                                                                                                |
| Credentials       | Preserve credentials during normal setup and uninstall; only `uninstall --credentials` or `uninstall --all` removes them.                                                                                                                         |

Run setup after package upgrades, path changes or partial installs to inspect the proposed repair before applying it:

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@<version> setup
```

## Upgrading Previous Installations

From 0.10.0, install this release and run `setup`. Runtime installation and shim replacement keep the installed agent commands unchanged; no uninstall or additional Codex hook re-trust is needed.

To upgrade from 0.9.0 or earlier, first run that release's uninstall, which keeps credentials, configuration and state, or `node <checkout>/dist/src/cli.js uninstall` for a checkout installation before updating that checkout. Its command matcher (`agent-presence hook`, `@rivus/agent-presence`, `agent-signature hook`, `agent-signature.mjs hook`, `dist/src/cli.js hook`) covers the hook command forms of every earlier release, apart from the checkout-path exceptions below, and it deletes both opencode bridge names and the marker-carrying Pi extension, so it also removes installations from those releases:

```bash
npx --yes @rivus/agent-presence@0.9.0 uninstall
```

Setup does not look for an older release, and this release's uninstall removes only ledger-recorded agent artifacts. If the old uninstall is skipped:

- Claude Code, Codex, Gemini CLI and Grok run both versions' hooks for each event, because the old entries in `~/.claude/settings.json`, `~/.codex/hooks.json` and `~/.gemini/settings.json` sit outside the kit's plugin, extension and `config.toml` locations; Grok also reads `~/.claude/settings.json`, so it runs the old `--source claude` hook. `doctor` reports the duplicates, with `grok` next to `claude-code`. The fix is the old uninstall followed by `setup` again: the old opencode uninstaller deletes `~/.config/opencode/plugins/agent-presence.js` unconditionally, which is also the kit bridge's path.
- opencode and Pi bridges sit at the same paths in both versions (`~/.config/opencode/plugins/agent-presence.js`, `~/.pi/agent/extensions/agent-presence.ts`), and the bundle carries no legacy markers, so `planInstall` reports each old bridge as `unmanaged-exists` with the choices `adopt` and `backup`; `setup --yes` stops there without naming the old uninstall. The documented answer is to cancel and run the old uninstall. `adopt` lets setup go on without it, so the old Claude Code, Codex and Gemini CLI hooks and the old `opencode.json` plugin entry stay. `backup` is worse: it records the old bridge as the pre-image, so a later `agent-presence uninstall` restores it and the old hook with it. The kit keeps an entry's first pre-image for the entry's whole life, so the old uninstall followed by `setup` does not clear it; users who already chose `backup` delete the restored bridges by hand after a later `agent-presence uninstall`. `doctor` does not inspect bridge files, so it reports neither old bridge.

The hook-command fragments of releases before 0.10.0 live in `src/cli/commands/doctor.ts` and only `doctor` uses them; they are never passed to the install bundle or uninstall. The kit's doctor matches markers only against hook commands, as plain substrings, so the list holds only command fragments specific to presence; the generic `dist/src/cli.js hook` is excluded. `doctor` adds the installed command expanded for each agent, allowing it to report an old marker-carrying command beside a new command in either hook command mode. Its duplicate checks do not inspect opencode or Pi bridge files, and old absolute-path commands from a checkout path without a presence marker are outside them.

The old uninstall matches the unquoted checkout form through `dist/src/cli.js hook`; a quoted checkout path, or a CLI path set through `AGENT_PRESENCE_CLI_PATH` that does not end in `dist/src/cli.js`, escapes that matcher and needs manual removal. That broad matcher also removes another tool's Claude/Codex/Gemini hook containing the same fragment, so users must preserve and restore unrelated entries if needed. The old uninstall reaches its targets only with the install-target override variables its setup used, such as `CLAUDE_SETTINGS_FILE`, which this release ignores. It also removes dsh and the macOS watcher; setup's watcher step and dsh prompt install them again.

## Downgrading to 0.9.0 or earlier

Downgrade in this order; `test/harness-downgrade.test.ts` exercises uninstall, `worker --stop` and the old setup in both hook-command modes, plus the reverse order; it does not run steps 2–3:

1. Run this version's `agent-presence uninstall`. It removes the artifacts the harness ledger records and reports anything it kept.
2. Read the uninstall report. Move everything it lists as kept out of the install locations, or remove it if unwanted.
3. Run `agent-presence doctor` for all six agents, inspect the kept artifacts and agent configuration it reports, and remove by hand any remaining new artifacts or entries that overlap the old release's locations.
4. Run `agent-presence worker --stop`. It applies the pending queued events, then writes the tombstone that keeps this version's hooks and worker from recording again.
5. Install the old release and run the old `agent-presence setup`. After it, each event must fire exactly once, with no duplicates or leftovers.

The harness ledger is a local file under `$XDG_STATE_HOME/agent-kit/harness` (default `~/.local/state/agent-kit/harness`); deleting it is not a downgrade step, because the ledger is what this version's uninstall uses to find its artifacts. Do not run the old setup while this installation remains: it adds its command hooks next to the kit registrations so overlapping events run twice, its opencode installer overwrites the kit-ledgered bridge file without updating the ledger, and its Pi installer refuses to overwrite the kit bridge and leaves a half-installed agent.

## Installed Agent Artifacts

The bundle installs at the following default user locations; the kit resolves overridden agent homes before planning.

| Agent       | Artifact                                                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/skills/agent-presence/`, containing `.claude-plugin/plugin.json` and `hooks/hooks.json`. No presence hook is added to `~/.claude/settings.json`.                                                                                                     |
| Codex       | When the `codex` CLI is available, `~/.codex/plugins/agent-presence/` holds the marketplace/plugin; `codex plugin` registers it in `~/.codex/config.toml` and Codex runs the installed cache copy. Without the CLI, hooks are groups in `~/.codex/config.toml`. |
| Gemini CLI  | `~/.gemini/extensions/agent-presence/`, containing `gemini-extension.json` and `hooks/hooks.json`.                                                                                                                                                              |
| Grok        | `~/.grok/hooks/agent-presence.json`.                                                                                                                                                                                                                            |
| opencode    | `~/.config/opencode/plugins/agent-presence.js`, generated by the kit bridge adapter.                                                                                                                                                                            |
| Pi          | `~/.pi/agent/extensions/agent-presence.ts`, generated by the kit bridge adapter and loaded from the extension directory.                                                                                                                                        |

`timeoutSeconds: 5` becomes `timeout: 5` for Claude Code, Codex and Grok, and `timeout: 5000` for Gemini. The opencode and Pi bridges apply a 5000 ms child-process timeout only to synchronous finish delivery. Other events are sent asynchronously without a child-process timeout. This corrects the old Claude Code and Codex writers' 5000-second timeouts to five seconds. Gemini registrations use its native `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent` and `SessionEnd` names instead of Claude-only names.

Claude's plugin placement avoids adding presence hooks to the shared settings file Cursor also reads. Presence installs no Cursor source; a Cursor payload that reaches `hook --agent` is skipped as described in [Hook Normalization](hook-pipeline.md#hook-normalization). Isolated tests prove the rendered artifacts and dialect behavior. Real-agent checks on the 0.11.0 release, each in an isolated temporary home with no earlier kit installation, verified the installed surfaces: Claude Code 2.1.301 fired the plugin's hooks once each per event after its old settings-file hooks were removed; Codex 0.162.1 reviewed the plugin's four hooks once at launch and ran all four after approval; Gemini CLI 0.64.0 loaded the extension and fired `SessionStart`, `BeforeAgent` and `SessionEnd` through it; Cursor CLI 2026.10.16 proceeded with tool calls and produced no presence event — the plugin hooks did not run. The migration re-trust of older Codex registrations was not exercised (see [Codex Hook Trust](#codex-hook-trust)). On that Cursor CLI version, Claude `PreToolUse`/`PostToolUse` canary groups in `~/.claude/settings.json` ran only once they carried a `matcher`; without one, no hook in the group ran, and `UserPromptSubmit`/`Stop` were not observed in print mode (Cursor's own `beforeSubmitPrompt`/`stop` hooks did not fire there either) — a third-party behavior this plugin placement does not rely on. Older Gemini CLI versions and the Cursor desktop app are untested; an older Gemini CLI that does not read its extensions directory gets no presence events, and `doctor` cannot detect that.

## Codex Hook Trust

Codex reviews each new or changed hook by a hash of its definition, including plugin hooks and hook groups in `config.toml`. A hook can be present but not executed until the user approves it.

The harness plan lists expected trust prompts before install confirmation. Moving existing registrations to the stable shim's `hook --agent` command is expected to require one re-trust cycle. Setup does not edit Codex trust state; the user approves through Codex, which records each approval as a `trusted_hash` under `[hooks.state]` in `~/.codex/config.toml`. After a setup rerun that changes no hook definition, a relaunch asks for no new review (observed on Codex 0.162.1). Later setup runs that only update the shim's pinned version or command mode keep the installed hook definition stable.

## Uninstall

`src/cli/commands/uninstall.ts` calls `uninstall("agent-presence", { agents })` without markers of older releases, reports each artifact removal, and lists every kept locator with its reason. It removes only the harness ledger's artifacts; entries from 0.9.0 or earlier, outside that ledger, stay untouched.

After the harness step, uninstall removes the stable shim, the whole `<presence home>/runtime/` directory, dsh plugin and macOS power watcher. The runtime is removed last so an uninstall invoked from it can still load its scripts and dependencies. These removals run independently: a kit failure is printed and makes the final exit non-zero, but does not prevent the shim, runtime, scripts or requested credential/state removals from running. Normal uninstall preserves credentials, provider/render configuration and session state.

Credential and data removal are explicit:

```text
agent-presence uninstall --credentials  removes credentials and slot identifiers from config
agent-presence uninstall --all          also removes session state, queued records and installed source plugins
```

`--all` writes the queue tombstone before takeover, then deletes the queue directory, stop requests and session state. The tombstone, epoch and worker lock database remain so late producers and workers cannot restore removed state; a later setup clears the tombstone under takeover. Other configuration keys are preserved. Uninstall is idempotent when no artifacts remain.
