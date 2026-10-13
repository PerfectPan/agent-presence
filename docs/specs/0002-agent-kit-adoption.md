# Spec 0002: Agent Kit Adoption

Adopts `@rivus/agent-kit` and `@rivus/agent-kit-collab` (the paired Plan records the pinned versions) for the areas tracked in issue #92: process locking, usage and pricing, hook interpretation, and hook installation. The adoption plan and the kit's migration guide live in the paired Plan. This Spec covers only the observable behavior that changes.

## Status

Draft

Paired Plan: [`docs/plans/0002-agent-kit-adoption.md`](../plans/0002-agent-kit-adoption.md)

## Problem And Scope

Presence hand-rolls what the kit now ships: a per-agent hook vocabulary, per-agent usage transcript decoding, a pricing table, install/uninstall flows, and process locks. The copies have already drifted from the agents they serve — Claude hook timeouts are written in the wrong unit (#85), Gemini is registered under Claude's event names (#86), and a Cursor agent that loads Claude's `settings.json` hooks treats presence's `PreToolUse` observer as a permission gate (#89).

In scope: the #85/#86/#89 fixes, a Grok presence and usage source, the kit's usage decoding corrections, and what `agent-presence setup`, `uninstall`, and the new inspection commands show and ask during install.

Out of scope: everything else. See "Unchanged behavior".

## Behavioral Requirements

- Installed command hooks carry their timeout in each agent's own unit: seconds for Claude Code, Codex, and Grok; milliseconds for Gemini CLI. A five-second intent installs as `timeout: 5` (Claude, Codex, Grok) and `timeout: 5000` (Gemini CLI). The installed Claude timeout falls from the mistaken 5000 seconds to 5 seconds, so Claude's shared per-event hook budget becomes 5 seconds, within Claude's 60-second ceiling.
- Gemini CLI hooks are registered under Gemini's own event names (`SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, `SessionEnd`). The previous-version entries under the Claude-only names (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) in the Gemini settings file are removed by the previous version's uninstall, which the upgrade runs first.
- With presence installed, a Cursor agent that loads Claude Code's hook configuration can run tool calls: presence's Claude hooks are not placed in a file Cursor reads, and any presence registration that would run as a silent observer on an event some runner treats as a permission gate is refused at install time — setup fails with that refusal instead of writing it.
- On an event that any runner may treat as a permission gate, the installed command prints a valid empty JSON object (`{}`) even when the hook CLI fails, so silence can never block the agent.
- Grok sessions move the presence value through the same states as other built-in sources, using Grok's own hook file.
- Grok usage counts toward `agent-presence usage` output and the signature usage badges under the `grok` source.
- Usage output and badges leave out a still-active source's trailing requests only where the kit's decoder does, per decoder: a Claude Code request stays unreported until four newer requests have been written in its conversation lane or the source has been quiet for 30 minutes — a single later request releases nothing; an opencode database message without a completion time stays unreported until it completes or the source has been quiet for 30 minutes (legacy JSON messages always carry a settle time and count immediately); a Gemini CLI, Pi, or Codex request is counted as soon as its record is complete. Today every record read is counted immediately, including a trailing request still being written.
- Usage decoding corrections taken from the kit (each observable on real transcripts):
  - Codex records billed at a non-standard service tier carry the multiplier from the record's own tier, not from the tier currently configured in the Codex config.
  - A Gemini CLI chat that the agent migrated from an older `.json` session file to a `.jsonl` file is counted once.
  - A Claude Code turn that was streamed and rewritten deduplicates per request; within a request the copy with the larger token total wins (a later copy only on ties), and across files the request is counted at its first occurrence — not per message-plus-request composite with a keep-first tie-break.
  - A Gemini CLI usage record's input tokens include the record's tool tokens, which today's scanner omits.
  - Usage entries copied from a parent session into a forked Pi session are not counted twice; today's scanner counts them.
  - A Codex `token_usage_record` takes precedence over `token_count` totals, and unchanged `token_count` totals are not re-counted; today's scanner handles neither.
  - An opencode database that exists but cannot be read surfaces as that source's failed contribution for the scan instead of silently falling back to the legacy JSON store; today's scanner falls back to the legacy store.
  - Token accounting follows the kit convention: `inputTokens` includes cache reads and writes, `outputTokens` includes reasoning; counts a transcript does not report are absent rather than zero.
- `agent-presence setup` shows, before writing anything to the agent targets: the files it will change and how, any agent commands it would run, the trust prompts the user should expect from each agent (for example Codex's hook review), hooks it had to drop and why, and notes about files it deliberately does not touch. It applies only after the user confirms, and verifies the result afterwards.
- `setup` asks only about conflicts it is allowed to resolve (adopt, back up, or force as each conflict permits); files managed by dotfiles tooling and symlinked targets are reported, never written.
- New `agent-presence doctor` and `agent-presence inventory` commands report installation health (duplicate, drifted, or legacy-hook problems) and the installed artifact ledger.
- While an agent target still holds entries that a previous version installed and `setup` can detect (the paired Plan 3.5 lists the ones it cannot), `agent-presence setup` writes nothing to the agent targets: it lists the entries it found and exits with an error asking the user to run the previous version's `agent-presence uninstall` first. It never removes those entries itself.
- `agent-presence uninstall` removes the artifacts this version installed and reports anything it kept. It leaves entries that a previous version installed; that version's own uninstall removes them.
- The kit's SQLite-backed process lock replaces the mkdir-based state lock and the hardlink-based log lock; a crashed process no longer leaves a lock that others must time out or reclaim. Both call sites keep today's bounded waits (about 2 seconds for state writes, about 2.5 seconds for log appends), except that the worker of [Spec 0003](0003-hook-event-queue.md) waits for the log lock before a dsh usage append instead of skipping the append; a handover interrupts that wait and leaves the append to the next worker.

## Unchanged Behavior

Everything not listed above stays unchanged, explicitly including:

- The npx-form installed hook command stays recognizable by its markers (`@rivus/agent-presence`, `agent-presence hook`); the absolute-path form keeps carrying `dist/src/cli.js hook` in its command text, but that generic fragment is not a marker — the paired Plan records which old command forms `setup` detects and which it does not.
- Presence source ids stay `claude`, `codex`, `gemini`, `opencode`, `pi`, `dsh` (plus the new `grok`); persisted state, render templates, and user configuration keep working.
- The presence state file format is unchanged: this adoption adds no state fields beyond Spec 0003's optional `queueApplied` and `queueOwed`, which older versions drop (usage scans are stateless — this depends on the paired Plan's usage-scan-state owner decision, whose alternative persists scan state), and older versions load files this version writes.
- Render templates, providers, keyring credentials, the power watcher, the dsh plugin flow, and the source-table mechanism.
- The hook path stays fast, bounded, non-interactive, and fail-open; Codex hooks still print `{}` — on every event, including successful context events.
- Presence still expires sessions after the inactivity TTL, still reopens a finished session on a new user prompt, and still falls back to finishing the most recent matching session.
- An opencode file edit still refreshes the running session, and an opencode `session.error` that names no session still finishes it: from kit 0.13.0 (agent-kit#86) the kit bridge carries the latest session id into such events, as the old bridge did.

## Domain Invariants

- Presence comes from lifecycle events, never from process scans.
- A hook never throws into or blocks the agent it runs in.
- Credentials live in Keychain, libsecret, or environment variables, never in config files, hook commands, logs, or signatures.
- A usage badge never mixes windows, and an aggregate badge is only rebuilt from a complete set of current-day source contributions.

## Acceptance Examples

### S1: Claude hook timeout unit

- Given `agent-presence setup` ran with this version
- When the installed Claude Code hook configuration is inspected
- Then each presence hook entry has `timeout: 5` (seconds), and no presence entry has `timeout: 5000`

### S2: Gemini event names and timeout unit

- Given a machine set up by a previous version, with Claude-named presence entries in the Gemini settings file
- When the previous version's `agent-presence uninstall` runs, and then `agent-presence setup` runs with this version
- Then the Gemini registration uses only `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, and `SessionEnd`, its timeout is in milliseconds (`5000`), and the entries under the Claude-only names (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) are gone

### S3: Cursor tool calls proceed

- Given presence is installed and a Cursor agent is configured to run Claude Code's `settings.json` hooks
- When the Cursor agent executes a tool
- Then the tool call proceeds (no permission block attributable to presence), and presence's `PreToolUse` observer is not registered in a file Cursor reads

### S4: Gate-event output is valid JSON

- Given a presence hook registered on an event that some runner treats as a permission gate
- When the hook CLI fails (non-zero exit or crash)
- Then the command still prints `{}` on stdout

### S5: Grok session presence

- Given Grok hooks are installed
- When a Grok session starts, runs tools, and finishes
- Then the presence value shows the session as running during the turn and finished after it

### S6: Grok usage

- Given Grok has run with transcript activity inside the window
- When `agent-presence usage` runs or a usage badge refreshes
- Then a `grok` contribution appears with token totals, and cost when the model price is known

### S7: Usage parity within named corrections

- Given the same transcript fixtures, window, and price table
- When the previous and new versions compute usage
- Then per-agent token and cost totals agree except for the corrections named in Behavioral Requirements (per-record Codex tier and `token_usage_record` precedence, Gemini migrated chats and tool tokens, streamed-turn dedup with the keep-largest rule, Pi forked-session parent skip, the opencode unreadable-database failure instead of legacy fallback, absent-versus-zero counts), each demonstrated on its own fixture, and except for the trailing-request behavior of S8 when a fixture contains a still-active source

### S8: Trailing-request lag (Claude Code, opencode)

- Given a Claude Code source wrote a request less than 30 minutes ago and has written nothing since
- When a usage scan runs
- Then the output and badges leave that open request out (up to four open requests per conversation lane)
- When the source has been quiet for more than 30 minutes, or writes four newer requests in that lane, and a scan runs again
- Then the withheld records are counted
- Given an opencode source with a message in its database that is not yet marked completed
- When a usage scan runs
- Then that message is left out; when it completes, or the source has been quiet for more than 30 minutes, a later scan counts it (messages in the legacy JSON store always carry a settle time and count immediately)
- Given a Gemini CLI, Pi, or Codex source whose latest request just completed
- When a usage scan runs
- Then that request is counted without waiting for quiet

### S9: Setup shows a plan before writing

- Given a machine with existing agent configuration
- When `agent-presence setup` runs
- Then it displays the planned file changes, commands, expected trust prompts, dropped hooks, and notes, and writes nothing to the agent targets until confirmation (credential setup and legacy-home migration may write before that), and reports verification results after applying

### S10: Setup conflicts

- Given a target file presence does not manage, a user-modified managed file, a dotfiles-managed file, and a symlinked target in various combinations
- When `setup` plans
- Then each conflict resolves only through its allowed choices, and dotfiles-managed and symlinked targets are reported and left unwritten

### S11: Upgrade after uninstalling the previous version

- Given a machine set up by the previous version
- When `setup` runs with this version
- Then it lists the previous version's entries, writes nothing to the agent targets, and exits with an error asking for the previous version's `agent-presence uninstall`
- When the previous version's `agent-presence uninstall` runs, and then `setup` runs with this version
- Then each event runs presence's hook exactly once, and `doctor` and `verify` report no duplicate or leftover entries; the documented exceptions are the entries `setup` cannot detect (paired Plan 3.5): an absolute-path command entry installed from a checkout whose path carries no presence marker, which the previous version's uninstall removes for an unquoted checkout path while a quoted one (for example containing a space) needs manual removal, and an entry at a location the kit already tracks or protects as the user's, which follows the kit's ordinary conflict rules instead

### S12: Uninstall and documented downgrade

- Given this version is installed
- When `agent-presence uninstall` runs, then `agent-presence worker --stop` (Spec 0003), then the previous version installs and sets up again
- Then uninstall reports everything removed, and the previous version's hooks fire exactly once per event with no leftovers from this version

### S13: Everything else unchanged

- Given any configuration, state file, and render template valid before this change
- When this version runs
- Then source ids, the hook command markers (`agent-presence hook`, `@rivus/agent-presence`), templates, providers, keyring usage, power watcher, dsh plugin flow, TTL expiry, reopen, and fallback-finish behave as before, and old state files load correctly

## Compatibility And Constraints

- Public API: none (no exported library surface). CLI: `hook`, `setup`, `uninstall`, `update` keep their names and existing flags; `doctor` and `inventory` are new.
- Upgrade from a previous version: run that version's `agent-presence uninstall` (without `--credentials` or `--all`, so credentials, configuration, and state stay), then install this version and run `setup`. When the previous version was set up with install-target override variables such as `CLAUDE_SETTINGS_FILE`, its uninstall runs with the same variables set; this version ignores them and `setup` warns when one is set. Later upgrades from this version need no uninstall.
- Persisted data: `PresenceState`'s usage shape is unchanged — scans are stateless and no usage fields are added, which depends on the paired Plan's usage-scan-state owner decision; the only new state fields are Spec 0003's optional `queueApplied` and `queueOwed`, which older versions drop. The kit's install ledger is a JSON file under `$XDG_STATE_HOME/agent-kit/harness/<scope>` (default `~/.local/state/agent-kit/harness`) with its own SQLite ledger lock, and the presence-side lock databases are new local files under the presence state directory.
- Configuration: no existing key changes meaning. `effect` is added as an exact dependency (`4.0.1`, required by the kit's `/harness` entry), and `engines.node` rises to `>= 22.13` (the kit's Node adapters).
- Package policy: `@rivus/agent-kit` is excluded from the repository's `minimumReleaseAge` window (`pnpm-workspace.yaml`, documented in `CONTRIBUTING.md`); whether `@rivus/agent-kit-collab` is excluded too is an owner decision recorded in the paired Plan; without that exclusion, collab versions age past the window before they are adopted.
- Operational bounds: the hook cold start must not get slower; Gemini CLI must be a version that reads extensions from its extensions directory (the version bound is unconfirmed and is verified during acceptance).

## Acceptance Evidence

- Scenario IDs and corresponding tests: not written yet; the paired Plan maps each scenario to a batch and test.
- Runtime or package evidence: not available yet; isolated-`HOME` install/verify/uninstall/downgrade runs and the owner-authorized real-agent checks (Claude, Cursor, Codex, Gemini — completion gates) are defined in the paired Plan.
