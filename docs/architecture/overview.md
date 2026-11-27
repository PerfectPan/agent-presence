# Agent Presence Architecture

`@rivus/agent-presence` turns local coding-agent lifecycle events into a Feishu signature link-preview value. The important boundary is that it models active work from agent hooks, not from process scans.

```text
Codex / Claude Code / Gemini CLI / opencode / Pi Coding Agent / Grok / dsh lifecycle hooks
-> CLI hook records one queue record and returns
-> background worker applies the record to locked JSON state
-> TTL pruning
-> debounce renderer
-> slot provider update
-> Feishu signature link preview
```

Three paths share this pipeline:

```text
interactive path: login / setup / config / status / url / update / reset
hook path:        agent lifecycle event -> silent CLI records it -> worker applies it -> optional slot sync
deferred path:    scheduled internal flush -> render cached state -> slot sync
```

The interactive path can use prompts and rich output. The hook path must be fast, bounded, non-interactive, and safe to call from another agent runtime: it only records.

## Architecture Documents

- [`hook-pipeline.md`](hook-pipeline.md) — state store, hook event queue, hook normalization, session state machine, active semantics, rendering, and debounced provider updates.
- [`providers-and-sources.md`](providers-and-sources.md) — provider registry, source table and token usage (`scanUsage`), slot and Magic-Builder providers, and Linux credential and power-watcher integration.
- [`installation.md`](installation.md) — setup idempotency, upgrades and downgrades, installed agent artifacts, Codex hook trust, and uninstall.

## Goals

- Count agents that are actively working.
- Keep Feishu profile writes out of the hot path by updating a reusable slot.
- Store credentials only in Keychain, libsecret, or environment variables.
- Make hooks safe to run inside coding-agent lifecycles.
- Recover from abnormal exits with TTL and power-event reset hooks.
- Support the macOS local-agent environment first, with Linux as a supported platform.
- Let `npx @rivus/agent-presence setup` be the easy install entrypoint, with installed hooks calling a stable shim under the presence home.
- Make setup and uninstall repeatable: rerunning either command should not duplicate hooks, lose user configuration, or leave half-written managed files.

## Non-Goals

- Process scanning or terminal-window detection.
- A generic status dashboard.
- Server-side session tracking.
- Windows runtime support.
- Full provider abstraction beyond the first Feishu signature slot provider.

## Runtime Foundations

### Local Directories

`src/config.ts` owns the local home directory. By default it is:

```text
~/.agent-presence
```

The home directory contains local state, config, logs, the hook shim, and setup-installed package runtimes. It is intentionally outside the package install directory so `npx`, global installs, and local checkouts share the same durable state.

```text
~/.agent-presence/
  state.json               local JSON state
  config.json              provider/render configuration
  agent-presence.log       hook and command diagnostics
  bin/agent-presence       stable executable hook shim, written by setup
  runtime/<version>/       pinned package and dependencies, installed by setup
```

Credentials are not stored in this directory. They live in Keychain (macOS), libsecret (Linux), or environment variables.

Reads, writes and logs use `~/.agent-presence` unless `AGENT_PRESENCE_HOME`, `AGENT_SIGNATURE_HOME`, or file-specific environment variables override the paths.

### CLI

`src/cli.ts` is the public entrypoint. It delegates immediately to `src/cli/app.ts`, which routes to one command module per command.

The CLI allows help output everywhere, then rejects unsupported runtime platforms through `src/platform.ts`. The direct installer scripts use the same guard.

Human-facing commands use `@clack/prompts` for interaction:

```text
login   -> intro, QR note, authorization spinner, outro
setup   -> conflicts, install plan, confirmation, apply results, verification, signature URL
config  -> text prompts when provider/render values are omitted in a TTY
```

Machine-facing commands stay plain:

```text
status/update/reset -> JSON or silent output
flush               -> internal cache-only deferred publisher
hook                -> pass-through `{}` for Codex or silent output for other agents
url                 -> raw URL only
```

This keeps the pretty CLI layer out of hook and automation protocols.

`setup`, `uninstall`, `doctor` and `inventory` load the harness lazily. `src/cli/harness.ts` is the sole Effect execution root, providing `HarnessLive` with `NodePlatformLive` and reporting failed programs on stderr with a non-zero exit code. Promise failures wrapped as Effect `UnknownError` print their message on one line. Other command modules may import Effect to construct programs and use its types; Effect runners, including aliases or destructured runners, and `Runtime`/`ManagedRuntime` imports or use stay in this root. Setup uses one harness program, the install program spanning planning across prompts, apply and verification. Queue recovery, config loading and login run before it outside Effect. The install program ends after verification; power-watcher installation, the dsh update or fresh-install prompt, and provider publishing then run outside Effect with their existing error handling and messages. The hook, status, render and usage paths do not load this root. `doctor` reports every check and fails on warnings or errors; `inventory` reads the ledger revision, entries and pending operations. Both support `--json`. Doctor's duplicate check covers command-hook files, not opencode and Pi bridge files. It recognizes the presence-specific hook-command fragments of releases before 0.10.0 and expanded installed commands; a presence home containing spaces may produce a false missing-program warning. It also reports `stale-path`, `unknown-event` and `timeout-unit` problems in other tools' hooks and exits 1 for them. Doctor does not repair agent targets, but checking the ledger lock can create harness lock files. Inventory includes every kit application's entries in the shared ledger, not only presence's.

`src/harness/bundle.ts` defines the `agent-presence` bundle for Claude Code, Codex, Gemini CLI, Grok, opencode and Pi: one observer hook spec with the package version, a stable artifact digest and `timeoutSeconds: 5` for command-hook registrations. Its command names `<presence home>/bin/agent-presence`, with `{agent}` expanded by the kit. Gemini uses its own event names and receives the timeout in milliseconds. The bundle has no markers of older releases, skills or MCP servers. Doctor uses those markers and expanded commands as duplicate markers. Setup installs the bundle through the harness and records its artifacts in the harness ledger; uninstall uses that ledger to remove them.

Setup selects install targets with `detectAgents` from `@rivus/agent-kit/discovery` for the six kit ids `claude-code`, `codex`, `gemini-cli`, `grok`, `opencode` and `pi`. It selects discovery services from `builtinProviders` in `@rivus/agent-kit/providers`, preserving that agent order, and passes them as provider overrides with `auth: {}`. With `versionProbe: false`, detection only stats commands on `PATH` and agent-owned session/state or credential paths. Empty auth probes disable credential-content and authenticating-variable reads; disabled version probes prevent agent commands from running. Presence needs evidence of installation, not a working version or login. Selection accepts `found` and `runnable`; this stat-only detection can return `found`, not prove `runnable`. A `missing` result prints an install-and-rerun instruction; `unknown` names the checks that failed and points to the explicit override.

The kit's [built-in evidence paths](https://github.com/PerfectPan/agent-kit/blob/v0.22.0/packages/discovery/README.md) are relative to each resolved data home: Claude Code has `projects/` and `.credentials.json`; Codex has `sessions/`, `archived_sessions/` and `auth.json`; Gemini CLI has `tmp/` and `oauth_creds.json`; Grok has `sessions/` and `auth.json`; opencode has `opencode.db`, `storage/message/` and `auth.json`; Pi has `sessions/` under its agent home (`~/.pi/agent/` by default). opencode uses its data home (`~/.local/share/opencode/`, or `$XDG_DATA_HOME/opencode/`), not its plugin/config home. Empty session stores count, and retained agent-owned state can establish `found` after an executable is removed. Bare agent homes, presence hooks/plugins, shared settings and MCP configuration do not count: presence installation must not create its own discovery evidence.

`setup --agents <id,...>` overrides detection with supported kit ids. A desktop-app-only installation whose CLI has never run and is absent from `PATH` requires this override. Unknown ids and kit ids without presence support are rejected. The selection goes to `planInstall` and the immediate post-install `verify`. Hooks for agents omitted by detection or the override stay unchanged. In the same install harness program, setup calls `inventory` and names unselected agents only when the ledger records entries owned by `agent-presence` for them. The notice shows `agent-presence setup --agents <id,...>` for those agents and explains that `agent-presence uninstall` removes presence hooks for all agents. An empty detected selection skips agent planning, confirmation, apply and post-install verification. Setup still prepares the selected hook-command mode and writes the shim: `package` installs or reuses the pinned runtime, while `absolute` uses the checkout CLI. A runtime installation failure stops setup before the shim or downstream watcher, dsh and provider steps; those steps run only after preparation succeeds. `doctor` and `uninstall` retain all six agents as their scope, so an agent disappearing from detection does not hide old artifacts or prevent their removal.

Setup calls the kit's `verify("agent-presence", { bundle, agents })` directly. The kit compares, reports and acknowledges only presence-owned ledger entries naming a selected agent or occupying a locator desired by a selected agent. Other entries stay unchanged. The bundle also makes desired artifacts missing from both disk and ledger visible. Ordinary planning can recover pending ledger operations; unresolved pending operations fail setup.

The CLI files are split by responsibility:

```text
src/cli/app.ts              command routing
src/cli/args.ts             argv parsing helpers
src/cli/ui.ts               Clack wrapper and non-TTY fallback
src/cli/slot-sync.ts        state-lock to provider-sync bridge
src/cli/hook-context.ts     built-in source hook context selection
src/queue/                  the hook event queue: record writer, reader, worker, takeover (see Hook Event Queue below)
src/sources.ts              source registry: built-ins plus configured plugin sources
src/usage/billable-sources.ts  the billable source table (usage command and badge refresh)
src/state-store.ts          state loading, saving and the state lock (the worker and the commands)
src/cli/commands/*.ts       one command or subcommand per file
src/json-file.ts            shared JSON read and atomic write helpers
src/process-lock.ts         the kit's process lock that the state and log locks take
src/kit-platform.ts         the kit's Node platform, created once per process on first use
src/hooks/context.ts        shared hook payload/env string extraction
```

The dispatcher loads each command's implementation with a dynamic `import()` inside its `case`, so a hook run loads only the modules the hook command needs. The dispatcher statically imports argument parsing, help, the platform check, and the small hook failure fallback `src/cli/hook-output.ts`, which pulls in the queue's record writer (`src/queue/produce.ts`) and with it the kit's process lock (`@rivus/agent-kit-collab/process-lock`), taken on the platform `src/kit-platform.ts` creates; nothing heavier crosses this static boundary. When loading the hook command's module rejects, `writeHookLoadFailure` records the same `hook failed` error record and emits the same hook output as a failure inside the hook command does, leaving the exit code at 0. Only the load is covered: an error that escapes the hook command itself also reaches the generic CLI catch. The hook command is the queue's producer: it resolves the source, session and event in process, writes one record (`src/queue/produce.ts`), checks without taking it whether the worker lock is held and starts a worker when none of this release or a newer one is applying (see [Hook Event Queue](hook-pipeline.md#hook-event-queue)); the worker, not the hook, appends usage, refreshes badges, updates the state and syncs the slot. The static import graph of the hook path, walked from `src/cli.ts` and the hook command, loads only repository modules, Node built-ins (`node:*`), and three npm entries: `@rivus/agent-kit/harness/events`, and `@rivus/agent-kit-collab/process-lock` with `@rivus/agent-kit/node` for the producer's lock check (both bundle `zod/mini` and load no module of the `zod` package). No other npm package is loaded, so no `effect`, no `zod`, and no `@clack/prompts`, and no setup, installer, login, Clack wrapper (`src/cli/ui.ts`), or scripts code. Nor does the graph reach the modules that hold schemas or scan transcripts: the config's schema module and validated loader (`src/config-schema.ts`), the queue's schema module (`src/queue/schema.ts`), the state store (`src/state-store.ts`), the usage events log (`src/usage-events-log.ts`), the billable source table (`src/usage/billable-sources.ts`), and the usage scanners (`src/usage/scan-*.ts`). `test/hook-graph.test.ts` walks that graph and fails if it reaches any of them. A static setup import in the hook graph would defeat this split even when tree-shaking would discard it elsewhere. The hook cold start must not regress: it is measured by hand on the built output (median of 20 runs of `hook --source claude --event UserPromptSubmit`, a fresh `HOME` each; about 50 ms on macOS with the worker lock held or free), and CI runs no timing test. A re-measurement kills the worker each run spawned before the next run and, for the held case, holds the lock with a stand-in that has written `<state>.worker.v`; otherwise the idle workers of earlier runs contend with each other, and one free-lock round measured 64.8 ms.

The package exposes both binaries:

```text
agent-presence   primary CLI
agent-signature  compatibility alias for older hooks
```

### Stable Hook Shim

Setup writes `<presence home>/bin/agent-presence` before the watcher and dsh steps; when agents are selected, it writes the shim after install confirmation and before applying the harness plan. `src/harness/shim.ts` writes a temporary file in the same directory, sets mode `0755`, and atomically renames it over the shim on every setup unless `--no-hooks` is passed.

The `/bin/sh` script directly `exec`s Node and the CLI, forwarding `"$@"`. It uses setup's `process.execPath` while that file exists, otherwise `node` on `PATH`. The default `--hook-command package` selects `<presence home>/runtime/<version>/node_modules/@rivus/agent-presence/dist/src/cli.js`. `--hook-command npx` remains an alias for `package`; it does not execute `npx`. With `--hook-command absolute`, the CLI is the checkout's `dist/src/cli.js` and setup installs no runtime. `AGENT_PRESENCE_HOOK_COMMAND` accepts the same modes. Every path is quoted with the shared `shellQuote`. Absolute mode requires the checkout to remain available.

In default mode, setup installs its exact published package version into a temporary sibling of `<presence home>/runtime/<version>/`. This follows install confirmation when agents are selected; an empty selection skips that confirmation. The installation command is:

```bash
npm install --prefix <temporary-runtime-directory> --registry=https://registry.npmjs.org --omit=dev --no-audit --no-fund --ignore-scripts @rivus/agent-presence@<version>
```

Setup uses `process.env.npm_execpath` when it points to npm's CLI script, otherwise `npm` on `PATH`. A runtime is reused only when its package manifest names the requested version and its `dist/src/cli.js` exists. A new runtime is renamed into place only after installation succeeds. On failure, setup cleans the temporary directory, discards any held harness plan and exits non-zero before writing the shim or any agent target or running downstream steps. npm and registry access are setup-time dependencies; the hook path runs the local CLI directly.

Before runtime installation, setup reads which runtime the previous shim selected; when agents are selected, this follows install confirmation. Pruning runs only at the end of a successful setup, under the runtime lock, after the watcher, dsh and provider steps. It retains this setup's version, if present, the runtime selected by the previous shim, and the runtime selected by the shim at prune time. It removes only other version directories and leftover `runtime/.install-*` installation directories; directories with other names are preserved. Keeping the shim's selected runtime protects an overlapping setup whose shim switch completed before an older setup reaches cleanup. Absolute-mode setup also keeps the previous shim's runtime even though it installs no runtime. Provider errors reported by the provider step do not skip pruning. The dsh plugin calls `<shim> hook --source dsh …`, and the macOS power watcher calls `<shim> reset --force --silent`. Their standalone checkout install scripts keep an existing shim or create an absolute-mode shim when none exists.

The installed hook command is `<shim> hook --agent {agent} 2>/dev/null || echo '{}'`, with the shim path shell-quoted. Its text is identical in both modes and stays stable across package upgrades; setup rewrites the shim's contents to select the package version or checkout. Uninstall removes the shim and the entire `<presence home>/runtime/` directory after the harness removal step.

Runtime installation and shim switching share a process lock at `<presence home>/runtime.lock.db` with pruning. Setup releases the lock before applying the harness plan and running watcher, dsh and provider steps. At successful cleanup it takes the lock, re-reads the shim with `readPresenceShimRuntimeVersion()`, and retains that version alongside this setup's version and the previous shim's version. Concurrent setups cannot prune a runtime between its installation and shim switch. The lock file stays outside `runtime/` so runtime removal never deletes it.

### Configuration

`src/config.ts` owns durable local configuration. Provider-specific options stay under the provider id, so the generic presence model does not need Feishu-specific names.

Commands, the queue worker, and a command's takeover parse the config file with zod/mini schemas when they load it (`src/config-schema.ts`): a field or map entry whose value does not parse loads as missing — absent, not an `undefined`-valued key — and is reported once per run on stderr as `config: ignored <path> (<reason>)`, the rest of the file loads, keys the schema does not know are kept at every level, and a non-object root loads as `{}`. Every write command starts from the file's content as read. The object whose fields the command sets is taken from the validated config (its broken values dropped, unknown keys kept) with the change applied; every other key at every level, ancestors and siblings, stays as it is in the file — a broken raw value's index keys are never spread into the file, and a sibling the command does not change keeps its broken value. An ancestor that is not a map is replaced by a map holding the change, and a reset under a non-map ancestor removes the key. When the root itself is not an object, the write base is `{}` and the change starts a fresh config. `config show` lists the dropped values as `configIssues`. The hook path keeps the schema-free read in `src/config.ts` — loading `zod` costs a hook about 22 ms — and resolves only its own source's entry (the user's entry for that id, else the shipped default), so a broken entry of another source cannot fail the hook. A broken entry of the hook's own source, or a `null` root, still fails open as one `hook failed` error record with exit 0; any other non-object root (an array, string or number) reads as no user entries, and the hook resolves the shipped default. The worker drops broken values silently.

The provider ids are:

```text
magic-builder      default; preview served by a published magic-builder FaaS
feishu-signature   direct l.garyyang preview; also the slot backend both providers write
```

`providerId()` resolves the `--provider` flag, then `AGENT_PRESENCE_PROVIDER` / `AGENT_SIGNATURE_PROVIDER`, then `config.provider`, then the default (`l-garyyang` is a legacy alias of `feishu-signature`). Bare `setup` and `url` use `defaultCommandProviderId()`, which ignores a persisted `config.provider` so an older config that still names `feishu-signature` does not pull them off the default; the flag and environment overrides still apply. Which provider is active never changes the write path: hooks, `update`, `flush`, and `reset` always publish to the same slot (see [Slot backend vs. provider](providers-and-sources.md#slot-backend-vs-provider)).

The `feishu-signature` provider can be configured with a base URL, preview base URL, image key, and target URL. Token and slot id are credentials, so they are resolved through `src/secret.ts` instead of being embedded in the URL.

## Observability

The project needs enough local observability to answer three questions quickly:

```text
Did the agent hook run?
Did local state change?
Did the provider request happen, skip, rate-limit, or fail?
```

### Local Command Log

`src/log.ts` writes a local bounded diagnostic log. The default path is:

```text
~/.agent-presence/agent-presence.log
```

It can be overridden with:

```text
AGENT_PRESENCE_LOG_FILE
AGENT_SIGNATURE_LOG_FILE
```

Hook commands write no log line: the producer records `skip` and `error` records instead, and the worker logs their lines — the event diagnostic (payload key names, a redacted session id), the skip and failure lines, and its own `worker.start`/`worker.exit` and batch lines. Timestamps are formatted in China time with an explicit `+08:00` offset so local traces are readable without mental UTC conversion. The log must not contain provider tokens, full Authorization headers, QR code tickets, or local prompt payloads.

`src/log-retention.ts` owns the append-and-retain boundary. Each writer takes the file's log lock, the kit's process lock on `<log>.lock.db` (the same kind of lock as the state lock, so a crashed writer releases it at once), appends the new event, and immediately compacts the file in place when it exceeds 5 MiB. This order also bounds a single oversized event without waiting for another write. Compaction keeps roughly the latest 1 MiB of bytes and preserves the file identity for processes that may already hold it open; the first retained line may therefore begin mid-line. A writer waits up to 2.5 seconds for the lock; if another writer still holds it, the diagnostic write is skipped rather than racing a truncate. A caller can pass its own abort signal instead of that wait, to wait until it holds the lock or its signal aborts. If the lock cannot be taken at all, for example because the directory is not writable or the lock path belongs to something else, the event is appended without maintenance, and the foreign path is left alone. Writers inside one process take turns before they try the lock, because the kit's first attempt against a held lock blocks the thread while it settles. Cleanup failures never break a hook or provider operation.

### Power Watcher Log

The LaunchAgent redirects stdout and stderr to:

```text
~/.agent-presence/power-watch.log
```

This log is for watcher startup/runtime failures. It should stay credential-free because the watcher only invokes `agent-presence reset --force --silent`.

The generated watcher script applies the same 5 MiB / latest-1-MiB policy before starting the watcher and whenever the watcher restarts, which bounds repeated Swift compile/startup failures. The long-running Swift watcher also checks once every 86,400 seconds so runtime output is cleaned even when the process stays healthy. Both paths compact in place because launchd owns the stdout/stderr file descriptors. Existing macOS installations must run `agent-presence setup --skip-login` once after upgrading to regenerate these persistent watcher files.

Retention limits:

- The 5 MiB trigger and the roughly 1 MiB tail are fixed; there is no time-based retention, archive, or user setting. Logs that user-supplied source handlers write elsewhere are not managed.
- A single event larger than the retained tail keeps only its most recent bytes.
- Releases before the kit lock locked the log through a hard-linked `<log>.agent-presence.lock` file, and older ones took no lock, so such a release running next to this one can race an in-place compaction. An upgrade uninstalls the previous release first.

### Provider Request Log

Provider request logging is structured, single-line, and redacted. The intent is to debug slot sync behavior without leaking credentials or noisy hook payloads. Successful login QR and login polling requests are intentionally not logged by default because login polls every few seconds; failures, rate limits, slot updates, and slot info reads are logged.

Successful slot update event shape:

```text
time=2026-05-15T18:00:00.000+08:00 level=info app=agent-presence pid=12345 type=provider.request provider=feishu-signature method=POST path=/api/slot/update status=200 durationMs=123 slotId=slot_xxx... valueLength=31 result=updated
```

For failures:

```text
time=2026-05-15T18:00:00.000+08:00 level=info app=agent-presence pid=12345 type=provider.request provider=feishu-signature method=POST path=/api/slot/update status=429 durationMs=80 slotId=slot_xxx... retryAfterMs=60000 result=rate-limited
```

Logging rules:

- Log request method, normalized path, status, duration, result, retry-after, slot id prefix, and value length.
- Do not log bearer tokens, raw Authorization headers, QR code tickets, full login URLs, raw provider response bodies, or full slot values by default.
- Treat 429 as a successful local outcome with `result: "rate-limited"` because local state remains correct and the next eligible sync can recover.
- Keep provider network I/O outside the state lock; logging must not extend lock hold time.

### Status Readback

`status` reads local state and rendered value using the configured provider. `status --remote` additionally reads the remote slot or the magic-builder FaaS preview. Together they are the primary readback tools for debugging mismatches:

```text
local activeCount/value differs from remote value -> debounce, 429, network, or provider write failure
local value is wrong                            -> hook/session/state normalization bug
remote value is wrong but local is correct      -> provider sync path bug or delayed write
```

## Failure Model

| Failure                                 | Expected behavior                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Agent exits without a finish hook       | Session expires after TTL.                                                                                                    |
| Hook command fails                      | Coding agent continues; every command hook prints `{}` to the agent.                                                          |
| Hook cannot record its event            | The hook still prints its output and exits 0; that event is lost.                                                             |
| Queue worker is killed                  | The kernel releases its lock; the next hook or command starts a worker, which applies each pending record once.               |
| Queue worker cannot start               | Records wait; the next hook tries again.                                                                                      |
| Provider returns 429                    | Local state remains correct; next non-debounced update can sync.                                                              |
| Laptop sleeps or lid closes             | On macOS, power watcher resets local and remote state to 0 when possible. On Linux, TTL pruning clears sessions after expiry. |
| Sudden power loss                       | Wake reset (macOS) and TTL clear stale sessions.                                                                              |
| Keychain is unavailable                 | Explicit environment variables can supply token and slot id.                                                                  |
| Linux has no secret-tool                | Credential operations bail with a clear install instruction; env vars still work.                                             |
| Runtime install fails during setup      | Temporary install is removed, the held plan is discarded, and setup exits non-zero before shim or agent-target writes.        |
| Setup's Node executable disappears      | The shim falls back to `node` on `PATH`; absolute mode also needs the checkout, and package mode needs its installed runtime. |
| Setup is interrupted halfway            | Agent targets stay unchanged before confirmation; after application starts, rerun setup to inspect and complete partial work. |
| Codex hooks are present but not trusted | The install plan lists expected trust prompts; approve the managed hooks in Codex settings.                                   |

## Security Boundaries

- Credentials live in Keychain (macOS), libsecret (Linux), or environment variables.
- Credentials are not written to git, the signature URL, logs, hook files, or local config files.
- On Linux, if neither environment variables nor libsecret (secret-tool) is available, credential operations fail with a clear error instead of falling back to plaintext storage.
- Hooks use lifecycle events instead of process scanning.
- Queue records hold normalized event fields only, never prompt text, tool arguments or credentials, in a 0700 directory with 0600 files; the worker runs as the user and listens on nothing.
- The provider writes only slot value changes, not Feishu profile fields.
- Codex hooks are pass-through and bounded by agent hook timeouts.
- Setup modifies only known hook/plugin/watcher locations and preserves unrelated user entries.
- Logs are local diagnostics. They must be redacted by construction and should remain useful even when shared in a bug report.
- The credential guarantees above ("not written to logs / never leaves the machine") describe the **built-in / default** code paths. A user-configured source `handler` (see [Source Table](providers-and-sources.md#source-table)) runs in-process with full CLI trust, which includes the ability to read the slot credential; agent-presence reduces the default exposure (curated env, path/config ownership checks, opt-in loading, redaction-safe fail-open logging) but does not sandbox the handler, so a `handler` is code the operator is responsible for vetting. The no-code `match` tier and `builtin:` entries run no user-supplied code and carry none of this risk.
- The `magic-builder` provider is the one deliberate exception to "credentials never leave the machine": its published FaaS embeds the l.garyyang slot bearer so it can read the slot on `magic.solutionsuite.cn`. This is gated behind explicit operator action and documented under [Magic-Builder Provider](providers-and-sources.md#magic-builder-provider); the embedded value is the low-sensitivity slot bearer only, never the magic-builder token (which stays in the OS keyring).

## Package And Release Safety

The repository is managed with pnpm and pins the package manager through `packageManager`; CI and the release job install that pnpm and the exact Node.js version in `.node-version` through `pnpm/setup`.

Supply-chain settings live in `pnpm-workspace.yaml`:

```text
minimumReleaseAge: wait before accepting newly published packages
minimumReleaseAgeStrict: fail instead of falling back to too-new versions
minimumReleaseAgeIgnoreMissingTime: require registry publish-time metadata
blockExoticSubdeps: block transitive git or tarball URL dependencies
strictDepBuilds: fail on unreviewed dependency build scripts
engineStrict: enforce Node engine compatibility
verifyDepsBeforeRun: do not auto-install before scripts
allowBuilds: the only dependency build scripts that may run
```

Every install runs the pnpm version in `packageManager`: another pnpm downloads it first (pnpm's default `pmOnFail`). CI installs with a frozen pnpm lockfile; dependency build scripts run only for packages `allowBuilds` sets to `true`. Release uses Changesets plus npm Trusted Publishing, so the GitHub workflow gets an OIDC token and does not need an npm token secret.

## Extension Points

New agent sources ship best as a built-in hook adapter that emits the shared lifecycle actions, registered in the shipped [Source Table](providers-and-sources.md#source-table). A source that cannot live in core — an internal agent, or one that must be onboarded without a public release — is added through a `plugins.sources` config entry (declarative `match` or a JS `handler`) that merges over the default table; the same mechanism lets an operator override or disable a built-in. New providers should implement the same slot-style contract first, so profile-specific or network-specific write logic stays behind provider boundaries. A provider may also be a pure **front-end** that reuses an existing slot store and only changes how the signature URL is published, as `magic-builder` does over `feishu-signature`.
