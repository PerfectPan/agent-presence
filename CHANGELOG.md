# Changelog

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
