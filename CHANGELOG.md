# Changelog

## 0.13.0

### Minor Changes

- [#145](https://github.com/PerfectPan/agent-presence/pull/145) [`a0b5e60`](https://github.com/PerfectPan/agent-presence/commit/a0b5e604c0f4f4c399a4f10aaaccee5977f88a49) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Price token usage from the LiteLLM table that ships with `@rivus/agent-kit` 0.22.0 (`@rivus/agent-kit/cost/prices`) instead of a committed 15-model snapshot, and upgrade `@rivus/agent-kit` and `@rivus/agent-kit-collab` to 0.22.0 (Effect stays 4.0.5). Prices now update with the kit version, and the chat models of Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Z.ai, Moonshot and MiniMax are priced, so models such as `glm-5.1`, `grok-4.20`, `kimi-k2.6` and `gemini-3.1-pro-preview` no longer show `n/a`. Costs follow current LiteLLM prices, for example `gpt-5.6-sol` at $4/$20 per million input/output tokens (was $5/$30) and `deepseek-v4-pro` at $1.32/$3.96 (was $0.435/$0.87).
  
  A table key now prices only its own model and its dated ids. `gpt-5.4-mini` and `gpt-5.5-pro`, which took the price of `gpt-5.4` and `gpt-5.5` because their ids contain them, get their own table prices, as do `claude-opus-4-5` through `claude-opus-4-7`, which took the `opus` alias's $15/$75. A suffixed variant of a model the table names, such as `gpt-5.5-codex`, `gpt-5.6-high`, `claude-sonnet-5[1m]` or a Bedrock `us.anthropic.…-v1:0` id, takes that model's price. The `opus` alias, which prices other Claude Opus ids the table does not name, charges `claude-opus-4-8`'s $5/$25 instead of $15/$75; Claude Opus 4, Opus 4.1 and Claude 3 Opus keep their $15/$75. GPT versions the table does not name, such as `gpt-5.7`, show `n/a` instead of GPT-5's price. A partial `usage.pricing` override now takes its missing rates from the model's own price, so `{ "opus": { "input": 9 } }` keeps `claude-opus-4-8`'s $25 output price instead of $75.

### Patch Changes

- [#143](https://github.com/PerfectPan/agent-presence/pull/143) [`d765eeb`](https://github.com/PerfectPan/agent-presence/commit/d765eeb77f0b121bbe8dff86d876ffa6d64583fe) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Upgrade `@rivus/agent-kit` and `@rivus/agent-kit-collab` to 0.21.1 with Effect 4.0.5 (the kit's required exact Effect peer). No kit API change. The kit's hook host sniffing fix reaches this app: a Claude Code hook event is no longer misattributed to Cursor when only the environment carries `CURSOR_VERSION`, so such events now drive Claude Code presence instead of being skipped with "no presence source". The kit's 0.21.1 session summary, redaction, Codex event id and ACP fixes touch transcript surfaces this app does not read.

- [#83](https://github.com/PerfectPan/agent-presence/pull/83) [`8a7b279`](https://github.com/PerfectPan/agent-presence/commit/8a7b279e8422037776fa62269a9f6f596265363d) Thanks [@PerfectPan](https://github.com/PerfectPan)! - dsh sessions no longer show as finished after the first turn. The managed dsh plugin reports `Stop` when the agent goes idle and `UserPromptSubmit` when it starts running again, instead of reporting `Stop` on `agent/turn-stopping`, which fires on every turn and can be followed by more steps. Rerun `agent-presence setup` to rewrite an installed plugin.

- [#138](https://github.com/PerfectPan/agent-presence/pull/138) [`970d2da`](https://github.com/PerfectPan/agent-presence/commit/970d2dac64a7aa978316cb7cb2ecb60b321d7e92) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Upgrade `@rivus/agent-kit` and `@rivus/agent-kit-collab` to 0.20.0 with Effect 4.0.4. Migrate setup discovery and agent display names to provider descriptors while preserving agent selection, disabled authentication and version probes, and the isolated hook path. No user-visible behavior changes are intended.

## 0.12.0

### Minor Changes

- [#136](https://github.com/PerfectPan/agent-presence/pull/136) [`ee1438c`](https://github.com/PerfectPan/agent-presence/commit/ee1438cfadcc70acccea7e8b5a86b409a4fd7244) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Setup no longer refuses to run when an installation from 0.9.0 or earlier is still present. To upgrade from 0.9.0 or earlier, first run that release's uninstall (`npx --yes @rivus/agent-presence@0.9.0 uninstall`, or `node <checkout>/dist/src/cli.js uninstall` for a checkout); it also removes what earlier releases installed. Remove two kinds of absolute-mode hook entry by hand, because the old uninstall misses them and `agent-presence doctor` cannot see them without a presence marker: one whose checkout path needed shell quoting (spaces, non-ASCII, `+`, `~`, …), and one from an `AGENT_PRESENCE_CLI_PATH` that does not end in `dist/src/cli.js`. If you skip the old uninstall, Claude Code, Codex, Gemini CLI and Grok (which also reads `~/.claude/settings.json`) run both versions' hooks and `agent-presence doctor` reports the duplicates: run the 0.9.0 uninstall, then run `agent-presence setup` again, because the old uninstall can delete the current opencode bridge. opencode and Pi bridges instead show up in setup as `unmanaged-exists` conflicts: cancel there and run the 0.9.0 uninstall. Do not choose `adopt` or `backup`: `adopt` goes on without the old uninstall, so the old Claude Code, Codex and Gemini CLI hooks and the old `opencode.json` plugin entry stay, and `backup` is worse, because a later `agent-presence uninstall` restores the old bridge. If you chose `backup` earlier, delete the restored `~/.config/opencode/plugins/agent-presence.js` and `~/.pi/agent/extensions/agent-presence.ts` by hand after running `agent-presence uninstall`.
  
  Credentials stored only under the Keychain service used before the rename, and files in the old `~/.codex/agent-signature` home, are no longer migrated or read. If `agent-presence status` reports `hasToken: false` after upgrading, log in again with `agent-presence login`. `uninstall --credentials` no longer deletes that old Keychain entry (service `agent-signature-slot-credential`); on macOS, remove it with `security delete-generic-password -s agent-signature-slot-credential -a "$USER"`.

## 0.11.0

### Minor Changes

- [#126](https://github.com/PerfectPan/agent-presence/pull/126) [`d517201`](https://github.com/PerfectPan/agent-presence/commit/d5172013fed4e91f17dd5b2926af32bedca7955b) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Install setup hooks only for agents detected through PATH commands or agent-owned session/state and credential-file existence. Bare agent homes, presence hooks, shared settings and MCP configuration do not count; detection runs no agent commands and reads no credential contents. Use `--agents <id,...>` to choose supported agents explicitly. A desktop-app-only installation whose CLI has never run and is absent from PATH requires this override.
  
  Keep existing hooks for unselected agents and name them only when presence owns their installation records, with separate update and all-agent uninstall instructions. Verify only selected agents' entries and desired locations through the kit. When no agents are found, still prepare the runtime and shim before watcher, dsh and provider setup.

### Patch Changes

- [#121](https://github.com/PerfectPan/agent-presence/pull/121) [`7702e5b`](https://github.com/PerfectPan/agent-presence/commit/7702e5baef1399e0034d783ef205bd6139474cf5) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Update hook help to show the installed `--agent` form and direct source calls, and only ask users to move kept files during setup refusal when kept files are present.

- [#125](https://github.com/PerfectPan/agent-presence/pull/125) [`e9f9c3b`](https://github.com/PerfectPan/agent-presence/commit/e9f9c3be27f26b9f3a2071581d4f38dfe61e174b) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Run hooks directly with Node through the stable shim instead of invoking npx. Setup installs its exact published version under the presence home's `runtime/<version>/` directory. `--hook-command package` is the default, with `npx` retained as an alias; `absolute` continues to use the checkout CLI. Invalid modes fail before install planning with a one-line error that names `--hook-command` for an explicit flag or `AGENT_PRESENCE_HOOK_COMMAND` for an environment value. Successful setup prunes under the runtime lock, keeping its version and the versions selected by the previous and current shim, and removes only unused version directories and leftover `runtime/.install-*` directories, preserving other directory names. Uninstall removes all runtimes.
  
  dsh and the macOS power watcher also use the shim. Setup automatically rewrites an already-installed presence dsh plugin, recognized by its marker, to use the shim without prompting, including with `--yes` or in a non-interactive terminal. Only a fresh dsh plugin install asks for confirmation and is offered only when dsh is detected in an interactive terminal. If the existing plugin cannot be read for its marker, setup prints one note, skips dsh work and continues provider setup and runtime pruning. `--no-hooks` neither inspects nor rewrites the plugin.
  
  Upgrading from 0.10.0 only requires installing this release and running setup. The installed agent commands are unchanged, so no uninstall or additional hook re-trust cycle is needed.

- [#124](https://github.com/PerfectPan/agent-presence/pull/124) [`2a2aa3e`](https://github.com/PerfectPan/agent-presence/commit/2a2aa3e4cd012a9eef6ca16ebc7731297a9ca01e) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Show setup's installation plan as readable file changes, commands, trust prompts, notes, dropped hooks, and conflict choices. Shorten home paths to `~` and summarize configuration entries without printing file contents. Explain shared hook registrations and entry removals in plain language, use the kit's agent names, and recognize symlinked home paths and trailing slashes.

## 0.10.0

### Minor Changes

- [#98](https://github.com/PerfectPan/agent-presence/pull/98) [`82d06eb`](https://github.com/PerfectPan/agent-presence/commit/82d06ebd56986f8b8e360aca3e54ecf002663f4b) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Add Grok as a built-in source. It appears in `agent-presence source list`, and `agent-presence hook --agent grok` reads a Grok hook payload as Grok sends it: Grok's snake_case event names (`session_start`, `user_prompt_submit`, `stop`, and so on) and their PascalCase spellings map to presence's lifecycle events, and subagent start and stop track their own session, `<sessionId>:subagent:<subagentId or subagentType>`. When Grok runs Claude Code's hooks, `hook --agent claude-code` counts the event for Grok. `hook --source grok` also works: it takes the event from `--event` when given, and otherwise maps the payload's event name the same way. `setup` installs Grok hooks at `~/.grok/hooks/agent-presence.json`.

- [#113](https://github.com/PerfectPan/agent-presence/pull/113) [`5e1e36b`](https://github.com/PerfectPan/agent-presence/commit/5e1e36b9e421e60f0a7e7a2bc091c0ea8d3a9de2) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Add `doctor` to report harness hook and ledger problems and `inventory` to list the ledger revision, installed entries and pending operations. Both support `--json`. Setup and uninstall use the same harness ledger. Duplicate checks cover command-hook files, not opencode or Pi bridge files. `doctor` also reports `stale-path`, `unknown-event` and `timeout-unit` problems in other tools' hooks and exits 1 for them. `inventory` includes every kit application's entries in the shared ledger, not only presence's.

- [#108](https://github.com/PerfectPan/agent-presence/pull/108) [`1d4c02a`](https://github.com/PerfectPan/agent-presence/commit/1d4c02a1eca94dd51f223d877ec6cfd46282551f) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Hooks now record each event in a durable queue and return immediately; a background `agent-presence worker` applies the recorded events, runs the follow-up work, and publishes, so a hook no longer takes locks or waits on the network. The state-changing commands (`status`, `reset`, `flush`, `update`) take over from the worker and apply what is pending first; their printed output is unchanged. Because the hook runtime changes, upgrading to this version requires uninstalling the previous release with its own `agent-presence uninstall` before installing this one, and downgrading requires `agent-presence worker --stop` first (then the previous release's `setup`, if that release has the queue).

- [#112](https://github.com/PerfectPan/agent-presence/pull/112) [`294be6f`](https://github.com/PerfectPan/agent-presence/commit/294be6f681d21c7d06debafc43875ef84ffae0a1) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Usage scanning for Claude Code, Codex, Gemini CLI, opencode, Pi, and Grok now runs through `@rivus/agent-kit`'s transcript decoders in one stateless scan per window, replacing the hand-rolled per-agent scanners. The same records are summed the same way as before — badges and totals read the same on unchanged transcripts — but the decoders count some records differently: Codex prices each record with its rollout's own service tier (priority processing ×2) instead of applying the current `~/.codex/config.toml` tier to every record, and counts `token_usage_record` entries it previously dropped; Gemini CLI counts a migrated chat once (from its `.jsonl` file) and now counts tool-use prompt tokens; Claude Code de-duplicates a request by its request id alone, so copies under a different message id no longer double-count; Pi skips the parent entries copied into a forked session; and a count a transcript does not report stays absent instead of `0`. Grok's completed turns now contribute usage with the cost Grok logged. `CODEX_HOME`, `PI_CODING_AGENT_DIR`, and `GROK_HOME` now locate transcripts for the scan, and a set `GEMINI_CLI_HOME` points at `$GEMINI_CLI_HOME/.gemini/tmp` (matching Gemini CLI's own layout) instead of `$GEMINI_CLI_HOME/tmp`. Two accepted behavior changes: an active Claude Code session's newest requests appear once four newer requests have been written in their lane or the session has been quiet for 30 minutes, and an `opencode.db` that exists but cannot be read no longer falls back to the legacy JSON store — its contribution is empty. `agent-presence usage --json` keeps `inputTokens` as input without the cache (cache reads and writes are separate fields) and `totalTokens` as the cache-inclusive input plus output, matching what the agents themselves report.

- [#87](https://github.com/PerfectPan/agent-presence/pull/87) [`fdfee49`](https://github.com/PerfectPan/agent-presence/commit/fdfee490c6247fc85ba5080630383266cb83a2c0) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Require Node.js 22.13 or newer. `@rivus/agent-kit`, which the hook command now uses, requires 22.13, and from 22.13 the built-in `node:sqlite` module loads without the `--experimental-sqlite` flag. Node.js 20 is end of life and no longer supported. The package also stops declaring a pnpm version in `engines`, which only applied to developing the repository.

- [#114](https://github.com/PerfectPan/agent-presence/pull/114) [`49a52b9`](https://github.com/PerfectPan/agent-presence/commit/49a52b92e15be8105bfdf3eb4394150fc0b23b58) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Install and uninstall coding-agent hooks through the harness ledger. Setup resolves conflicts before showing the full install plan, requires confirmation before writing agent configuration, applies the accepted plan and immediately verifies the kit artifacts before the watcher, dsh and provider steps. Non-interactive setup requires `--yes` for a conflict-free plan and never resolves conflicts automatically.
  
  Use Claude Code's plugin location instead of the shared settings file Cursor also reads, Gemini's extension with its native event names, Codex's plugin or `config.toml`, Grok's own hook file, and kit-generated opencode/Pi bridges. Set five-second timeouts in the native units of Claude Code, Codex, Gemini CLI and Grok command hooks, correcting the old Claude Code and Codex timeouts of 5000 seconds and the old Claude-style Gemini registrations. The opencode/Pi bridges limit synchronous finish delivery to five seconds; other events are sent asynchronously without a child-process timeout.
  
  Installed hooks call a stable shim at `~/.agent-presence/bin/agent-presence` that setup rewrites to the pinned package version or the absolute checkout command, so later upgrades leave the installed hook commands unchanged.
  
  Uninstall reports removed and kept artifacts, then removes the shim, dsh plugin and power watcher; independent cleanup continues if the harness fails. Credentials, configuration and state are preserved by default. Previous-release hooks outside the ledger are not removed by this version; use that release's own uninstall before upgrading, following the upgrade guidance. Remove the superseded per-agent hook install/uninstall scripts and their aggregate commands; keep the dsh and watcher scripts.

### Patch Changes

- [#87](https://github.com/PerfectPan/agent-presence/pull/87) [`fdfee49`](https://github.com/PerfectPan/agent-presence/commit/fdfee490c6247fc85ba5080630383266cb83a2c0) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Update the interactive prompt library `@clack/prompts` from 1.3.0 to 1.8.1, which `login`, `setup`, `config` and `source add` use. Since clack 1.6, `note()` no longer dims its content, so the boxed hints in an interactive terminal (the login QR code, the signature URL and Magic-Builder token help in `setup`, the `source add` trust notice) render at full brightness instead of dimmed.

- [#109](https://github.com/PerfectPan/agent-presence/pull/109) [`6111b94`](https://github.com/PerfectPan/agent-presence/commit/6111b94ecdfb3215a28ea43d813a33720089aca5) Thanks [@PerfectPan](https://github.com/PerfectPan)! - An invalid config entry is now ignored with a warning that names it (`config: ignored <path> (...)` on stderr) instead of breaking hooks and commands: the rest of the config still loads, keys the release does not know are kept, and a write command changes only what it is meant to change. Hooks keep reading the config without a schema and fail open on their own source's broken entry; the background worker drops broken entries silently.

- [#116](https://github.com/PerfectPan/agent-presence/pull/116) [`a02b12d`](https://github.com/PerfectPan/agent-presence/commit/a02b12ded24fcf72cd6ae5bfaf486eca7514c47b) Thanks [@PerfectPan](https://github.com/PerfectPan)! - `hook --source opencode` and `hook --source pi` no longer read the payloads of the bridges that releases before this one installed; configured sources reusing `builtin:opencode` or `builtin:pi` follow the same shipped resolver rule. Raw `session.created`, `session.deleted`, `session.error`, and `session.idle` events now count as heartbeats in direct `hook --source <any> --event <raw name>` calls and configured `match` sources resolving those names.

- [#97](https://github.com/PerfectPan/agent-presence/pull/97) [`7aecf1b`](https://github.com/PerfectPan/agent-presence/commit/7aecf1b51a159d175c92f794e274fcb4e1badbef) Thanks [@PerfectPan](https://github.com/PerfectPan)! - The hook command no longer loads setup code, which shortens hook start-up.

- [#115](https://github.com/PerfectPan/agent-presence/pull/115) [`9b3035d`](https://github.com/PerfectPan/agent-presence/commit/9b3035dc19108b45d11dcf91847109ae8a443424) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Upgrading from 0.9.0 or earlier: run the previous release's own uninstall first, then install this release and run `agent-presence setup`. Setup refuses while entries an earlier release installed remain, lists them, and names the command to run: `npx --yes @rivus/agent-presence@<version> uninstall` for each version a listed hook command pins, and `0.9.0` for entries that pin none (bridge files, opencode config references); from a checkout, `node <checkout>/dist/src/cli.js uninstall`. Run it without `--credentials` or `--all` to keep credentials, configuration and state, and with any old install-target override variables still set (this release ignores them and warns when they are set). Files kept from an earlier removal are listed too and must be moved or removed by hand first, because the old uninstall would delete them.
  
  Absolute-path commands from a checkout path that carries no presence marker cannot be detected; check those agents' configuration after the uninstall. The old uninstall also removes another tool's Claude, Codex or Gemini hook whose command contains `dist/src/cli.js hook`; restore such entries afterwards if you need them. `doctor` reports a previous release's command hook left next to the new one. Moving to the stable shim's `hook --agent` command asks for one Codex hook review; later upgrades only rewrite the shim.

## 0.9.0

### Minor Changes

- f7e868a: Add dsh (DeepSeek harness) as a built-in source. `agent-presence setup` prompts to install a managed Cordis plugin into `~/.dsh/plugins/` (registered in the home-level `~/.dsh/cordis.patch.yml`, which applies to every profile). The plugin bridges dsh lifecycle events to presence (`agent/session-start` → running, `agent/pre-step` / `tools/*` → heartbeat, `agent/turn-stopping` → finished) and reports each model call's token usage in real time via the hook payload, which `agent-presence` appends to a local usage log. The `usage` command and signature badge read that log back, so dsh contributes to the same calendar-day windows and totals as the transcript-scraping sources — without scraping dsh's zstd transcripts. Install or remove any time with `pnpm run install:dsh-plugin` / `pnpm run uninstall:dsh-plugin`.

## 0.8.8

### Patch Changes

- abe42a3: Keep bare `setup` and `url` commands on the `magic-builder` preview provider, even when an older config persists `feishu-signature`; the direct-preview provider remains available through an explicit override.

## 0.8.7

### Patch Changes

- 52e1a9d: Bound diagnostic log growth by compacting logs larger than 5 MiB to their latest roughly 1 MiB, including the macOS power watcher log. Existing macOS users should rerun `agent-presence setup --skip-login` once after upgrading to refresh the persistent watcher files.

## 0.8.6

### Patch Changes

- 6d7cd92: Match ccusage when Claude emits cache-creation TTL buckets by summing the five-minute and one-hour breakdown instead of trusting a stale or zero top-level total.

## 0.8.5

### Patch Changes

- 422fe08: Refresh all built-in usage sources at the first session boundary after midnight, or when the aggregate cache has not been initialized, so inactive sources contribute zero instead of leaving the signature stuck at `今日 —`. Keep failed scans retryable and prevent slower overlapping refreshes from overwriting newer usage.

## 0.8.4

### Patch Changes

- 8b0fe05: Match ccusage pricing for current Codex and Claude transcripts by adding exact `gpt-5.6-sol` and `claude-sonnet-5` prices, honoring Codex's configured priority tier, and pricing Claude one-hour cache creation separately.

## 0.8.3

### Patch Changes

- a2f6ecc: Keep deferred slot delivery cache-only so agent hooks cannot trigger a cross-source usage rescan. Preserve cached usage badges when macOS power events reset active sessions, and reject cross-midnight source snapshot mixtures.

## 0.8.2

### Patch Changes

- dea55af: Scope signature usage refreshes to the agent that emitted the session-boundary hook. Cache per-source contributions for aggregation, while keeping `agent-presence update` as the explicit full-refresh path, so an OpenCode event cannot rescan or overwrite Codex usage.

## Unreleased

### Patch Changes

- Keep bare `setup` and `url` commands on the `magic-builder` preview provider, even when an older config persists `feishu-signature`; the direct-preview provider remains available through an explicit override.
- Bound diagnostic log growth by compacting logs larger than 5 MiB to their latest roughly 1 MiB, including the macOS power watcher log. Existing macOS users should rerun `agent-presence setup --skip-login` once after upgrading to refresh the persistent watcher files.
- Match ccusage when Claude emits cache-creation TTL buckets by summing the five-minute and one-hour breakdown instead of trusting a stale or zero top-level total.
- Refresh every built-in usage contribution at the first session boundary after midnight, or when initializing a cache without an aggregate timestamp, so sources that remain unused today contribute zero instead of leaving the signature stuck at `今日 —`. Failed scans keep the previous cache retryable, and overlapping refreshes cannot let older results overwrite newer usage.
- Match ccusage cost semantics for current Codex and Claude logs: price `gpt-5.6-sol` and `claude-sonnet-5` exactly, apply Codex's configured priority tier, and distinguish Claude one-hour cache creation from the default cache-write rate.
- Keep deferred slot flushes cache-only so an OpenCode hook retry cannot fall through to `agent-presence update` and rescan Codex, Claude, or other sources.
- Preserve cached token usage when the macOS power watcher clears active sessions on sleep, lid close, or wake; custom `{usage_Nd}` templates no longer collapse to an empty label such as `今日 `.
- Refuse to aggregate per-source usage snapshots from different calendar days, so the first hook after midnight cannot label yesterday's cached totals as today's usage.

## 0.8.1

### Patch Changes

- 8d86578: Prevent Codex Desktop subagent transcript replays from inflating token totals in `agent-presence usage` and the Feishu signature badge. Forked session replay prefixes are now excluded using the same event semantics as ccusage while genuine subagent usage remains counted.

## 0.8.0

### Minor Changes

- acda502: Price supported models from a committed LiteLLM snapshot instead of relying only on the small hand-written fallback table. The snapshot is generated by `pnpm run update-pricing`, kept intentionally small via a supported-model allowlist, and refreshed by a weekly GitHub Action PR.

  This fixes usage cost estimates for models already seen in supported sources, including `gpt-5.5`, `claude-fable-5`, `deepseek-v4-pro`, and `gemini-3-flash-preview`, while preserving `config.usage.pricing` overrides and `n/a` for unknown models.

## 0.7.0

### Minor Changes

- 9e3e6c3: Model every presence source — built-in and third-party — as an entry in one source table, so operators can add, override, or disable a source purely by config. The five built-ins ship as a default table (`sources.default.json`, each referencing its in-code resolver via a `builtin:<id>` handler); a user's `plugins.sources` in `~/.agent-presence/config.json` merges over it by id: a same-id entry overrides a built-in, a new id adds a source, and `enabled: false` disables one. Not writing anything leaves the shipped defaults in effect.

  A source resolves via `builtin:<id>` (trusted, raw env), a no-code declarative `match` spec (payload/env field mappings), or a JS `handler` module (npm specifier or absolute path). `agent-presence config show` prints the merged table with each source's origin, kind, and override flag.

  A new `agent-presence source add/list/remove` command downloads and registers a source-plugin npm package: `add` runs `npm install` (with `--ignore-scripts`, and a `--registry`/`AGENT_PRESENCE_REGISTRY` override for internal registries) into an isolated plugins dir (`~/.agent-presence/plugins/`), validates the package exports a real source plugin, and records a `plugins.sources` entry; `remove` unregisters and uninstalls it; `uninstall --all` clears the plugins dir. Because it downloads and runs third-party code in the credential-bearing process, `add` prints a trust notice and requires `--yes` or an interactive confirmation.

  JS `handler` loading is opt-in and guarded: the handler receives a credential-stripped env, absolute-path handlers must be user-owned, non-symlink, and non-world-writable, `handler` entries are ignored when `config.json` is world-writable, and any load/resolution failure fails open so a source can never break a hook. Trust follows the `builtin:` marker, not the id, so overriding a built-in drops to the guarded path. No behavior change when no `plugins.sources` is configured.

- 6985bd1: Unify token/cost accounting under the source table: `SourcePlugin` gains an optional `scanUsage(window)` capability, so a source is one thing that declares all of its capabilities. A source that implements `scanUsage` is billable; one that omits it (any `match` source) contributes presence only.

  `agent-presence usage` (and the signature usage badge) now iterate the merged source table's billable sources dynamically via `billableSources()` — through the same trust/resolution path as presence — instead of a hardcoded `claude/codex/pi` trio. A JS `handler` source can therefore be billable too; the hook/badge path never loads third-party handlers (`includeHandlers: false`).

  All five built-ins are now billable. The three existing scanners (Claude, Codex, Pi) are wired onto their built-in `scanUsage` unchanged, and two new scanners are added:

  - **opencode** — reads the local SQLite store (`~/.local/share/opencode/opencode.db`, with a legacy JSON fallback) via node's builtin `node:sqlite`, imported dynamically so Node <22 is unaffected; trusts opencode's logged per-message cost like Pi.
  - **Gemini CLI** — reads the local chat transcripts (`~/.gemini/tmp/<hash>/chats/`, honoring `GEMINI_CLI_HOME`); priced from the table like Codex. This corrects the earlier, now-incorrect claim that Gemini keeps no local per-message token log.

  `UsageSource` widens from the `'claude' | 'codex' | 'pi'` union to `string`. The pricing pipeline and the presence/source-table semantics are unchanged.

## 0.6.1

### Patch Changes

- 1760b62: Introduce a `PresenceProvider` interface and provider registry so CLI commands resolve providers through `createProvider(id, …)` and assert the capability each command needs (`assertSupportsLogin` / `assertSupportsPublish` / `assertSupportsSignatureUrl`), instead of importing the storage backend directly.

  The shared remote value store is modelled explicitly as a `SlotBackend` (`LGaryYangSlotBackend`): both `feishu-signature` and `magic-builder` compose the same backend for login/publish/info and differ only in the signature URL (and magic-builder's remote preview), so neither provider depends on the other. The capability layer uses a generic `publishValue` (not `updateSlot`) so a future provider with its own storage can implement `PresenceProvider` without a slot backend. No user-facing behavior change.

## 0.6.0

### Minor Changes

- 37e2590: Make `magic-builder` the default provider. Feishu's link-preview pipeline does
  not reliably render the direct `l.garyyang.work` page, while the
  `magic.solutionsuite.cn` FaaS front-end is accepted — so a bare
  `agent-presence setup` / `url` / `status` now targets magic-builder. Slot value
  updates still flow to the l.garyyang backend (the push path is provider-agnostic),
  and `feishu-signature` remains fully supported as the underlying slot backend and
  a direct-preview alternative via `--provider feishu-signature`.

  Existing installs are unaffected: `login` persists an explicit `provider` in
  config, so the new default only applies to fresh setups. New users will be
  prompted for a Magic-Builder token during setup (the direct `feishu-signature`
  preview needs no token).

### Patch Changes

- a401c1f: Token usage windows are now calendar-day aligned instead of rolling 24h. `今日`
  counts from local midnight (and resets at 00:00) rather than sliding as a
  `[now-24h, now)` window — which previously made the figure _decrease_ mid-day as
  old activity aged out. A window of N days spans N local calendar days inclusive
  of today.

  Also: a cached signature badge whose window has fully rolled over since it was
  computed (one midnight for `今日`, N days for `近N天`) now renders as `—` instead
  of a stale number, until the next session-boundary refresh recomputes it. The
  template label is preserved.

## 0.5.0

### Minor Changes

- 9c9c9aa: Add `agent-presence usage` for rolling-window token consumption (ccusage-style).
  Scans Claude, Codex, and Pi transcripts after the fact (Gemini does not persist
  local token usage), reports tokens and an estimated USD cost per source over
  configurable windows (default: last 1d and 7d). The signature can show usage via
  render-template variables `{usage}` / `{usage_1d}` / `{usage_7d}` / `{usage_Nd}`
  (compose your own label), or `usage.showInSignature` for a zero-config badge;
  badges refresh only on session boundaries. Pricing is overridable per model in
  `config.usage.pricing`.

## 0.4.0

### Minor Changes

- 1f5e6f9: Add `magic-builder` provider as an alternate front-end for the signature URL. `agent-presence setup --provider magic-builder` publishes (or updates) a small CommonJS FaaS to `https://magic.solutionsuite.cn/api/faas` and emits `https://magic.solutionsuite.cn/r?fid=<record_id>` as the signature URL. Hooks continue to write into the l.garyyang slot exactly as before — the FaaS pulls the current value from `/api/slot/info` each time Feishu refreshes the preview (default cache 60s). Use this when the existing `feishu-signature` URL stops rendering inside Feishu (e.g. the personal-signature iframe whitelist changes).

  In an interactive terminal, setup prints the token-acquisition steps (open the 妙笔 Feishu bot, send `dev`, copy the reply) and prompts for the token, then stores it in the OS keyring (Keychain / libsecret) under `agent-presence:magic-builder`. Token resolution order is `MAGIC_TOKEN` env → keyring → `~/.magic-token` → `<cwd>/.magic-token`; the plaintext file is still read for skill-pack compatibility but is no longer written by this CLI.

- 3edfb19: Add Pi Coding Agent (`@earendil-works/pi-coding-agent`) as a supported source. Setup installs a managed Pi extension at `~/.pi/agent/extensions/agent-presence.ts` that bridges Pi lifecycle events (`before_agent_start`, `turn_start`, `tool_execution_*`, `agent_end`, `session_shutdown`) into the existing presence state/render/provider pipeline. Pi appears in render details as a `pi N` source group. Uninstall removes only the managed extension and never deletes user-owned Pi extensions or other settings.

## 0.3.3

### Patch Changes

- 499c57c: Reopen expired sessions when a later live heartbeat arrives, while still ignoring late heartbeats for finished sessions.

## 0.3.2

### Patch Changes

- a826641: Format diagnostic logs as China-time logfmt lines.

## 0.3.1

### Patch Changes

- 5d90ef5: Reopen a finished agent session when a new user prompt arrives with the same session id, while still ignoring late async heartbeats after stop events.
- 8adc558: Avoid repeated QR login during setup by reusing existing credentials. Setup still starts login when credentials are missing, `--skip-login` keeps hook repair login-free, and `--login` forces fresh authentication.

## 0.3.0

### Minor Changes

- 67225e2: Add Linux platform support:
  - Hook installers, status, update, reset, url, and config commands now work on Linux
  - Credentials stored via secret-tool (libsecret) with env var fallback; plaintext config fallback is rejected with a clear error message
  - Power watcher skipped on Linux (TTL pruning covers expired sessions); RFC documents the rationale
  - Credential storage abstracted behind a `CredentialBackend` interface (`KeychainBackend` / `SecretToolBackend`)
  - CI runs on both macOS and Linux with OS-specific integration tests

### Patch Changes

- 150c787: Improve Claude hook session detection from transcript paths, add redacted hook diagnostics for troubleshooting missing session ids, log each slot update attempt/result without storing rendered signature text, and schedule a deferred flush when a rendered update is debounced or rate-limited.

## 0.2.3

### Patch Changes

- 35829a2: Avoid repeated legacy-home migration prompts by removing known legacy files after they exist in `~/.agent-presence`.

## 0.2.2

### Patch Changes

- 47ce8a2: Add absolute hook command installation for restricted PATH agent environments, move the default local home to `~/.agent-presence` with setup-time legacy migration, remind users to approve changed Codex hooks, record redacted provider request logs, and accept Codex desktop conversationId payloads.

## 0.2.1

### Patch Changes

- 46ae26f: Fix opencode presence so lifecycle events use real session ids instead of event or message ids, load the generated plugin as a default export, and prevent late async heartbeats from resurrecting finished sessions.

## 0.2.0

### Minor Changes

- fde39ee: Add Gemini CLI support for agent presence synchronization including hooks and auto-installation scripts.

## 0.1.4

### Patch Changes

- 036ffe7: Prefer Claude hook payload session ids over process env ids so stop events target the same session as start and heartbeat events.
- a14cbcd: Fix Codex setup and uninstall deduplication for fixed-version npx hook commands.

## 0.1.3

### Patch Changes

- 11b9515: Fix Codex stop events that report an unstable session id by finishing the latest matching running session instead of leaving the active count unchanged.

## 0.1.2

### Patch Changes

- 89e9cd7: Add a first-class `agent-presence uninstall` command for local hooks, plugins, and the power watcher, support credential/state cleanup flags, install npx-compatible fixed-version hook commands, and migrate the release workflow to npm Trusted Publishing/OIDC.

## 0.1.1

### Patch Changes

- 8b6776a: Fix Feishu signature login parsing for confirmed credential responses.

## 0.1.0

### Minor Changes

- 05bf44d: Add the initial Agent Presence CLI for syncing local coding-agent lifecycle events to Feishu signature link previews.

### Patch Changes

- 05bf44d: Document the first npm publish bootstrap path and allow the release workflow to use a temporary NPM_TOKEN before Trusted Publishing is configured.
- 05bf44d: Use Clack prompts for human-facing CLI flows and split the CLI implementation into focused command, routing, UI, hook, and slot-sync modules.
- 05bf44d: Document macOS-only support, add runtime platform guards for CLI and installer scripts, and share JSON file helpers across config, state, and hook installers.
- 05bf44d: Document the runtime architecture and switch repository package management, CI, and release workflows to pnpm with explicit supply-chain safety settings.
