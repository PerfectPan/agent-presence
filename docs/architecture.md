# Agent Presence Architecture

`@rivus/agent-presence` turns local coding-agent lifecycle events into a Feishu signature link-preview value. The important boundary is that it models active work from agent hooks, not from process scans.

```text
Codex / Claude Code / opencode lifecycle hooks
-> CLI hook normalizer
-> locked JSON state
-> TTL pruning
-> debounce renderer
-> slot provider update
-> Feishu signature link preview
```

Two paths share this pipeline:

```text
interactive path: login / setup / config / status / url / update / reset
hook path:        agent lifecycle event -> silent CLI -> local state -> optional slot sync
```

The interactive path can use prompts and rich output. The hook path must be fast, bounded, non-interactive, and safe to call from another agent runtime.

## Goals

- Count agents that are actively working.
- Keep Feishu profile writes out of the hot path by updating a reusable slot.
- Store credentials only in Keychain or environment variables.
- Make hooks safe to run inside coding-agent lifecycles.
- Recover from abnormal exits with TTL and power-event reset hooks.
- Support the macOS local-agent environment first.
- Let `npx @rivus/agent-presence setup` be the easy install entrypoint without making installed hooks depend on an ephemeral `npx` cache.
- Make setup and uninstall repeatable: rerunning either command should not duplicate hooks, lose user configuration, or leave half-written managed files.

## Non-Goals

- Process scanning or terminal-window detection.
- A generic status dashboard.
- Server-side session tracking.
- Windows or Linux runtime support in the MVP.
- Full provider abstraction beyond the first Feishu signature slot provider.

## Runtime Components

### Local Directories

`src/config.ts` owns the local home directory. By default it is:

```text
~/.agent-presence
```

The home directory contains local state, config, and logs. It is intentionally outside the package install directory so `npx`, global installs, local checkouts, and future managed runtimes all share the same durable state.

```text
~/.agent-presence/
  state.json               local JSON state
  config.json              provider/render configuration
  agent-presence.log       hook and command diagnostics
  runtime/                 managed hook runtime, when setup materializes one
  bin/                     stable hook shims, when setup materializes them
```

Credentials are not stored in this directory. They live in Keychain or environment variables.

When setup finds a legacy `~/.codex/agent-signature` directory, it asks before copying known local files into `~/.agent-presence`. Existing destination files are never overwritten. The legacy `~/.codex/agent-signature/config.json` path is still read when the new config file does not exist, so a skipped migration does not break first-run setup. New writes and logs use `~/.agent-presence` unless `AGENT_PRESENCE_HOME`, `AGENT_SIGNATURE_HOME`, or file-specific environment variables override the paths.

### CLI

`src/cli.ts` is the public entrypoint. It delegates immediately to `src/cli/app.ts`, which routes to one command module per command.

The CLI allows help output everywhere, then rejects non-macOS runtime commands through `src/platform.ts`. The direct installer scripts use the same guard.

Human-facing commands use `@clack/prompts` for interaction:

```text
login   -> intro, QR note, authorization spinner, outro
setup   -> intro, installer spinner, signature URL note, outro
config  -> text prompts when provider/render values are omitted in a TTY
```

Machine-facing commands stay plain:

```text
status/update/reset -> JSON or silent output
hook                -> pass-through `{}` for Codex or silent output for other agents
url                 -> raw URL only
```

This keeps the pretty CLI layer out of hook and automation protocols.

The CLI files are split by responsibility:

```text
src/cli/app.ts              command routing
src/cli/args.ts             argv parsing helpers
src/cli/ui.ts               Clack wrapper and non-TTY fallback
src/cli/slot-sync.ts        state-lock to provider-sync bridge
src/cli/hook-context.ts     source-specific hook context selection
src/cli/commands/*.ts       one command or subcommand per file
src/json-file.ts            shared JSON read and atomic write helpers
src/hooks/context.ts        shared hook payload/env string extraction
```

The package exposes both binaries:

```text
agent-presence   primary CLI
agent-signature  compatibility alias for older hooks
```

### Managed Hook Runtime

`npx` is a convenient installer but a poor hook target. Some agent runtimes launch hooks with a minimal `PATH`, and `npx` may resolve through a temporary cache that can move or be pruned. The setup architecture therefore treats `npx` as a bootstrapper, not as the durable runtime.

The target shape is:

```text
npx @rivus/agent-presence@<version> setup
-> install or update a managed runtime under ~/.agent-presence/runtime
-> write stable shims under ~/.agent-presence/bin
-> install Codex / Claude Code / opencode hooks that call those shims by absolute path
-> prompt the user to approve updated Codex hooks when Codex requires trust
```

The hook command should point to a stable file owned by Agent Presence, for example:

```text
/Users/<user>/.agent-presence/bin/agent-presence-hook --source codex --event SessionStart
```

It should not point to:

```text
npx @rivus/agent-presence@latest ...
<npm-cache>/_npx/.../node_modules/@rivus/agent-presence/...
```

Versioned setup can still preserve reproducibility by materializing the exact package version that invoked setup. Future setup runs replace the managed runtime atomically and then rewrite hooks to the new stable shim.

### Configuration

`src/config.ts` owns durable local configuration. Provider-specific options stay under the provider id, so the generic presence model does not need Feishu-specific names.

The current provider id is:

```text
feishu-signature
```

The provider can be configured with a base URL, preview base URL, image key, and target URL. Token and slot id are credentials, so they are resolved through `src/secret.ts` instead of being embedded in the URL.

### State Store

`src/state.ts` stores the local state as JSON under the user state directory. Updates are guarded by a local lock file so concurrent hooks do not clobber each other.

State has two layers:

```json
{
  "sessions": {
    "thread_id": {
      "id": "thread_id",
      "source": "codex",
      "kind": "coding",
      "status": "running",
      "startedAt": 1778576582452,
      "lastHeartbeatAt": 1778576891386
    }
  },
  "lastSlotUpdateAt": 1778577015486,
  "lastValue": "1 个 AI 牛马正在搬砖 | codex 1"
}
```

`sessions` is the event-derived truth. `lastSlotUpdateAt` and `lastValue` are the renderer/provider debounce checkpoint.

### Hook Normalization

The hook adapters in `src/hooks/` map each agent's lifecycle vocabulary to the shared session state:

```text
start event      -> running
heartbeat event  -> running with fresh lastHeartbeatAt
finish event     -> finished
idle event       -> finished
```

Current source mapping:

```text
Codex       SessionStart, UserPromptSubmit, PreToolUse, Stop
Claude Code SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure, SessionEnd, SubagentStart, SubagentStop
opencode    session.created, command.executed, file.edited, message.*, permission.*, session.*, todo.updated, tool.execute.*
```

Codex hooks always print `{}` so they remain valid pass-through hooks. Claude Code and opencode hooks run with `--silent`.

Hook commands are managed entries. Installers identify them by the `agent-presence hook` or legacy `agent-signature hook` command shape, remove the old managed entries, and then add the current managed entry. This keeps reruns from accumulating duplicate hooks.

### Active Semantics

Active means "currently doing agent work", not "the terminal is open".

```text
running session with heartbeat inside TTL -> active
finished session                         -> inactive
no heartbeat for TTL                     -> expired and inactive
sleep / lid close / logout / shutdown    -> reset to 0
wake                                     -> reset to 0 again
```

The default TTL is 3 minutes. This handles abnormal exits, hard kills, and missed finish hooks without scanning local processes.

### Rendering

`src/render.ts` groups active sessions by source and formats the slot value:

```text
0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex X · claude Y · opencode Z
```

Templates are configurable through `agent-presence config render` and environment variables. Rendered values are capped at 200 characters before provider update.

### Debounce And Provider Updates

Slot writes are rate-limited because the slot provider should not be hammered by hook traffic. Hooks update local state immediately, then the renderer compares the newly rendered value with `lastValue` and `lastSlotUpdateAt`.

Normal updates obey the debounce interval. `update --force` and `reset --force` bypass the local debounce when the user or power watcher explicitly asks for a sync.

Network I/O is kept outside the state mutation lock. That keeps hook contention small and prevents a slow provider request from blocking unrelated lifecycle writes.

### Provider Interface And Registry

`src/providers/types.ts` defines the `PresenceProvider` interface and a small set of capability assertions. Every method is optional because not all providers will support every capability:

```text
createQrCode / getLoginStatus  login flow (slot-style providers that pair the CLI with QR auth)
updateSlot                     write a rendered presence value
getInfo                        return remote presence info for `status --remote`
buildSignatureUrl              produce a link-preview URL for the slot helper
```

`src/providers/registry.ts` maps each provider id to a factory. CLI commands never instantiate a concrete provider class anymore; they call `createProvider(id, { baseUrl, credential })` and then use `assertSupports*` helpers when a capability is required. Providers that omit a capability raise a clear `provider "<id>" does not support <capability>` error at the call site.

`src/providers/l-garyyang.ts` is the first concrete implementation and conforms to `PresenceProvider`. It still owns the slot backend:

```http
GET  /api/slot/wechat/qrcode
GET  /api/slot/wechat/login-status?sceneId=...
POST /api/slot/update
GET  /api/slot/info
```

The Feishu signature stores a link like:

```text
https://l.garyyang.work/?t2=<base62({{slot id="slot_xxx"}})>
```

The URL references the slot helper only. It must not contain tokens, local state, or machine-specific paths.

### Setup And Idempotency

`src/setup.ts` and `src/installers.ts` coordinate first-run setup:

- login or reuse existing provider credentials
- write provider preview configuration
- install Codex hooks
- install Claude Code hooks
- install the opencode plugin
- install the macOS power watcher
- force an initial slot sync

Each installer is idempotent. Existing unrelated user configuration is preserved.

Idempotency is part of the installer contract, not a nice-to-have:

| Area | Idempotency rule |
| --- | --- |
| Provider login | Reuse existing Keychain credential and configured slot unless login is explicitly run again. |
| Config | Merge provider/render settings without deleting unrelated keys. |
| Codex hooks | Remove prior managed Agent Presence hooks, add exactly one current managed group per event, then remind the user to approve changed hooks in Codex settings. |
| Claude Code hooks | Remove prior managed Agent Presence hooks, add exactly one current managed group per event. |
| opencode plugin | Rewrite the managed plugin file from the current package; do not append duplicate plugin registrations. |
| Power watcher | Replace the managed LaunchAgent plist and script, then reload the same label. |
| Managed runtime | Install into a staging directory first, then atomically switch the active runtime or shim target. |
| Legacy home migration | During interactive setup, ask before copying known files from `~/.codex/agent-signature` to `~/.agent-presence`; never overwrite existing destination files. |
| State | Preserve local session state during setup; only `reset` or `uninstall --all` clears it. |
| Credentials | Preserve credentials during normal setup and uninstall; only `uninstall --credentials` or `uninstall --all` removes them. |

This makes the supported repair command simple:

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@<version> setup --provider feishu-signature
```

Users should be able to run that command repeatedly after package upgrades, hook corruption, path changes, or partial installs.

### Codex Hook Trust

Codex Desktop stores a trust hash for each hook entry. Rewriting `~/.codex/hooks.json` changes those hashes, so a hook can be present but not executed until the trust state is updated.

Setup should:

1. Write the managed Codex hooks.
2. Print a clear reminder that Codex may require approval before updated hooks run.
3. Leave `~/.codex/config.toml` trust state untouched.

This keeps Agent Presence from silently changing Codex's trust database. The cost is one manual approval step when Codex marks hooks as new or modified.

If Codex later exposes an official trust API or CLI command, setup can call that supported interface for the managed Agent Presence hooks only. Until then, the CLI should prompt instead of editing TOML trust hashes directly.

### Uninstall

`uninstall` removes managed integration points while preserving user-owned data by default:

```text
agent-presence uninstall
-> remove managed Codex hooks
-> remove managed Claude Code hooks
-> remove managed opencode plugin
-> unload and remove managed power watcher
-> keep Keychain credentials, provider config, and state
```

Credential and data removal are explicit:

```text
agent-presence uninstall --credentials  removes credentials and slot config
agent-presence uninstall --all          removes hooks, credentials, config, state, and managed runtime
```

Uninstall is also idempotent. Running it on a machine with no installed hooks should be a clean success.

## Observability

The project needs enough local observability to answer three questions quickly:

```text
Did the agent hook run?
Did local state change?
Did the provider request happen, skip, rate-limit, or fail?
```

### Local Command Log

`src/log.ts` writes a local append-only diagnostic log. The default path is:

```text
~/.agent-presence/agent-presence.log
```

It can be overridden with:

```text
AGENT_PRESENCE_LOG_FILE
AGENT_SIGNATURE_LOG_FILE
```

Current hook commands log notable failures such as missing session ids or hook exceptions. The log must not contain provider tokens, full Authorization headers, QR code tickets, or local prompt payloads.

### Power Watcher Log

The LaunchAgent redirects stdout and stderr to:

```text
/tmp/agent-presence-power-watch.log
```

This log is for watcher startup/runtime failures. It should stay credential-free because the watcher only invokes `agent-presence reset --force --silent`.

### Provider Request Log

Provider request logging is structured and redacted. The intent is to debug slot sync behavior without leaking credentials or noisy hook payloads. Successful login QR and login polling requests are intentionally not logged by default because login polls every few seconds; failures, rate limits, slot updates, and slot info reads are logged.

Successful slot update event shape:

```json
{
  "time": "2026-05-15T10:00:00.000Z",
  "app": "agent-presence",
  "pid": 12345,
  "type": "provider.request",
  "provider": "feishu-signature",
  "method": "POST",
  "path": "/api/slot/update",
  "status": 200,
  "durationMs": 123,
  "slotId": "slot_xxx...",
  "valueLength": 31,
  "result": "updated"
}
```

For failures:

```json
{
  "time": "2026-05-15T10:00:00.000Z",
  "app": "agent-presence",
  "pid": 12345,
  "type": "provider.request",
  "provider": "feishu-signature",
  "method": "POST",
  "path": "/api/slot/update",
  "status": 429,
  "durationMs": 80,
  "slotId": "slot_xxx...",
  "retryAfterMs": 60000,
  "result": "rate-limited"
}
```

Logging rules:

- Log request method, normalized path, status, duration, result, retry-after, slot id prefix, and value length.
- Do not log bearer tokens, raw Authorization headers, QR code tickets, full login URLs, raw provider response bodies, or full slot values by default.
- Treat 429 as a successful local outcome with `result: "rate-limited"` because local state remains correct and the next eligible sync can recover.
- Keep provider network I/O outside the state lock; logging must not extend lock hold time.

### Status Readback

`status --provider feishu-signature` reads local state and rendered value. `status --provider feishu-signature --remote` additionally reads the remote slot. Together they are the primary readback tools for debugging mismatches:

```text
local activeCount/value differs from remote value -> debounce, 429, network, or provider write failure
local value is wrong                            -> hook/session/state normalization bug
remote value is wrong but local is correct      -> provider sync path bug or delayed write
```

## Failure Model

| Failure | Expected behavior |
| --- | --- |
| Agent exits without a finish hook | Session expires after TTL. |
| Hook command fails | Coding agent continues; Codex receives `{}`. |
| Provider returns 429 | Local state remains correct; next non-debounced update can sync. |
| Laptop sleeps or lid closes | Power watcher resets local and remote state to 0 when possible. |
| Sudden power loss | Wake reset and TTL clear stale sessions. |
| Keychain is unavailable | Explicit environment variables can supply token and slot id. |
| `npx` cache disappears after setup | Managed hooks keep working because they target the stable runtime or shim. |
| Setup is interrupted halfway | The previous runtime/config remains usable; the next setup run can repair managed files. |
| Codex hooks are present but not trusted | Setup prints a reminder; approve the managed hooks in Codex settings. |

## Security Boundaries

- Credentials live in Keychain or environment variables.
- Credentials are not written to git, the signature URL, logs, or hook files.
- Hooks use lifecycle events instead of process scanning.
- The provider writes only slot value changes, not Feishu profile fields.
- Codex hooks are pass-through and bounded by agent hook timeouts.
- Setup modifies only known hook/plugin/watcher locations and preserves unrelated user entries.
- Logs are local diagnostics. They must be redacted by construction and should remain useful even when shared in a bug report.

## Package And Release Safety

The repository is managed with pnpm and pins the package manager through `packageManager`.

Supply-chain settings live in `pnpm-workspace.yaml`:

```text
minimumReleaseAge: wait before accepting newly published packages
minimumReleaseAgeStrict: fail instead of falling back to too-new versions
minimumReleaseAgeIgnoreMissingTime: require registry publish-time metadata
blockExoticSubdeps: block transitive git or tarball URL dependencies
strictDepBuilds: fail on unreviewed dependency build scripts
pmOnFail: require the declared pnpm version
engineStrict: enforce Node engine compatibility
verifyDepsBeforeRun: do not auto-install before scripts
```

CI installs with a frozen pnpm lockfile and `--ignore-scripts`. Release uses Changesets plus npm Trusted Publishing, so the GitHub workflow gets an OIDC token and does not need an npm token secret.

## Extension Points

New agent sources should add a hook adapter that emits the shared lifecycle actions. New providers should implement `PresenceProvider` in `src/providers/types.ts` and register a factory in `src/providers/registry.ts`. A provider only needs to expose the capabilities it actually supports; the CLI asserts each capability at the call site and surfaces a clear error if a command runs against a provider that does not implement it.
