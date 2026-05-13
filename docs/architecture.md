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

## Goals

- Count agents that are actively working.
- Keep Feishu profile writes out of the hot path by updating a reusable slot.
- Store credentials only in Keychain or environment variables.
- Make hooks safe to run inside coding-agent lifecycles.
- Recover from abnormal exits with TTL and power-event reset hooks.

## Non-Goals

- Process scanning or terminal-window detection.
- A generic status dashboard.
- Server-side session tracking.
- Full provider abstraction beyond the first Feishu signature slot provider.

## Runtime Components

### CLI

`src/cli.ts` is the public entrypoint. It parses commands, resolves configuration, loads provider credentials, and dispatches hook, setup, status, update, reset, and config operations.

The package exposes both binaries:

```text
agent-presence   primary CLI
agent-signature  compatibility alias for older hooks
```

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

### Provider

`src/providers/l-garyyang.ts` implements the first slot backend:

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

### Setup

`src/setup.ts` and `src/installers.ts` coordinate first-run setup:

- login or reuse existing provider credentials
- write provider preview configuration
- install Codex hooks
- install Claude Code hooks
- install the opencode plugin
- install the macOS power watcher
- force an initial slot sync

Each installer is idempotent. Existing unrelated user configuration is preserved.

## Failure Model

| Failure | Expected behavior |
| --- | --- |
| Agent exits without a finish hook | Session expires after TTL. |
| Hook command fails | Coding agent continues; Codex receives `{}`. |
| Provider returns 429 | Local state remains correct; next non-debounced update can sync. |
| Laptop sleeps or lid closes | Power watcher resets local and remote state to 0 when possible. |
| Sudden power loss | Wake reset and TTL clear stale sessions. |
| Keychain is unavailable | Explicit environment variables can supply token and slot id. |

## Security Boundaries

- Credentials live in Keychain or environment variables.
- Credentials are not written to git, the signature URL, logs, or hook files.
- Hooks use lifecycle events instead of process scanning.
- The provider writes only slot value changes, not Feishu profile fields.
- Codex hooks are pass-through and bounded by agent hook timeouts.
- Setup modifies only known hook/plugin/watcher locations and preserves unrelated user entries.

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

New agent sources should add a hook adapter that emits the shared lifecycle actions. New providers should implement the same slot-style contract first, so profile-specific or network-specific write logic stays behind provider boundaries.
