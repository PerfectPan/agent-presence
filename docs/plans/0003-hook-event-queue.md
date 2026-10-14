# Hook Event Queue

- Status: in review
- Owner: unconfirmed
- Reviewer: PerfectPan
- Last updated: 2026-10-14
- Paired Spec: [`docs/specs/0003-hook-event-queue.md`](../specs/0003-hook-event-queue.md)

## Contents

1. Background and goals
2. Outline
3. Detailed design
4. Rollout and stability
5. Verification
6. Execution plan
7. Risks, open questions, and follow-up

## 1. Background and goals

### 1.1 Current behavior and constraints

Line references are to the code on `main` after Plan 0002 batch 4
([#98](https://github.com/PerfectPan/agent-presence/pull/98)).

- The hook command does presence's work before it answers. `hook` (`src/cli/commands/hook.ts`) writes a diagnostic log
  line (`:35`), appends a dsh usage event before the usage refresh (`:56-58`), rescans transcripts for usage at a session
  boundary (`:65-66`), then runs `syncRenderedSlotWithDeferredFlush` (`:69`). That sync takes the state lock to decide
  (`src/cli/slot-sync.ts:125`) and saves its claim (`lastSlotUpdateAt`) before publishing; outside the debounce interval
  it awaits the publish without holding the lock (`slot-sync.ts:84`), which reads the provider credential (`hook.ts:81`)
  and publishes over the network (`hook.ts:84`), and then takes the lock again to record success (`slot-sync.ts:102`) or
  to roll back (`slot-sync.ts:34`). Inside the interval it records `pendingSlotFlushAt` under the lock
  (`src/cli/deferred-update.ts:45`) and spawns a detached process that runs `flush --force --silent` one full debounce
  interval after this event (`src/cli/rendered-slot-sync.ts:23-27`, `deferred-update.ts:8-24`). The output is written
  last (`hook.ts:108`, `:132`).
- `slot-sync.ts:146` is a different path: `update --value` (`src/cli/commands/update.ts:31`).
- The debounce interval defaults to 60 seconds (`src/config.ts:12`). `reset --force` and the deferred `flush --force`
  publish without waiting for it (`src/cli/commands/reset.ts:26-35`, `deferred-update.ts:20`).
- The state lock (`withStateLock`, `src/state.ts:307`) waits up to 2 seconds (`:313`) and reclaims a lock directory left
  for 10 seconds (`:314`). The log lock (`appendRetainedLogLine`, `src/log-retention.ts:190`) guards each append and the
  in-place compaction that keeps the last 1 MB once the file passes 5 MB (`:5`, `:6`, `:46`); after 250 retries (`:11`)
  it returns without writing. State writes are atomic (temporary file and `rename`, `src/json-file.ts:8`);
  `normalizeState` keeps only the fields it knows (`src/state.ts:139-145`), so older releases drop new fields.
- dsh usage events go through that log lock (`src/usage-events.ts:31-32`), so an append can be skipped under contention.
- Writers of the state file: the hook, `flush`, `reset` (also run by the macOS shutdown watcher, which waits for it
  without a deadline, `src/power-watcher.ts:126`, `:185`, `:189`), `status` (`src/cli/commands/status.ts:24`), `update`
  (`update.ts:31`, `:52`, `:55`), the usage badge refresh (`src/cli/usage-badge.ts:110`, which refreshes only the
  calling source after the first refresh of a day, `:71-79`), the deferred-flush scheduling (`deferred-update.ts:45`),
  and `uninstall --all`, which deletes it (`src/cli/commands/uninstall.ts:11`).
- Configuration is resolved per process: the state and config paths and provider overrides (`src/config.ts:117-128`,
  `:153-166`), credentials that may come from the environment (`src/secret.ts:41-57`), and transcript roots such as
  `CLAUDE_CONFIG_DIR` (`src/usage/scan-claude.ts:11-16`).
- Source resolution writes log lines when it loads or refuses a configured handler and when a resolver fails
  (`src/sources.ts:189-273`, `:304-309`, `:371-375`), and the hook-module load fallback writes one
  (`src/cli/hook-output.ts:18-21`), all through the log lock (`src/log.ts:23-26`). The diagnostic log records payload key
  names and a redacted session id, never payload values (`src/cli/hook-diagnostics.ts`).
- Measured on macOS (median of 20 runs, a fresh `HOME` each): one Codex `Heartbeat` run takes six locks (four log, two
  state). The baseline for every figure in this Plan is 143 ms: `main` before Plan 0002's build split (batch 3,
  [#97](https://github.com/PerfectPan/agent-presence/pull/97)), with the mkdir and hardlink locks. On that baseline the
  build split alone measured 124 ms. The kit's process lock in place of both locks (Plan 0002 batch 1, with
  PerfectPan/agent-kit#78) measured 176 ms on the same pre-split code, 33 ms over the baseline
  ([agent-kit#74](https://github.com/PerfectPan/agent-kit/issues/74)): the first acquire's `sysctl` and `ps` (about
  7 ms) plus six acquisitions at about 4-5 ms each (24-30 ms). The lock was not measured on top of the build split.

### 1.2 Problem

The agent waits for presence's state, usage and network work, and every hook takes locks on the agent's path. Moving
those locks to the kit's crash-safe process lock, which Plan 0002 batch 1 needs, makes each hook slower still.

### 1.3 Goals and success criteria

- The hook records the event and returns: no lock taken (it only checks, without waiting, whether a worker holds the
  worker lock), no log line, credential read, transcript scan or network call on its path, and no `zod` in its import
  graph (Spec 0003, 3.2).
- Hook cold start at most 60 percent of the 143 ms baseline (1.1), about 85 ms, in the same measurement.
- One process per state file applies events in the Spec's order; each event's state change, dsh usage and usage refresh
  take effect exactly once across crashes; publishing behaves as today.
- The kit's process lock is used for what it is built for: one worker instance, which producers detect without taking
  the lock (3.3); the state and log locks leave the hook path.

### 1.4 Non-goals

- A system service (LaunchAgent, systemd unit) or an always-on daemon.
- A socket transport; it may come later as a wake-up hint, with the queue directory still the source of truth.
- A Node-free shell producer (section 7).
- Changes to interpretation rules (Plan 0002), providers, rendering, usage, or publishing behavior and timing.

## 2. Outline

### 2.1 Design principles

- Durable first: an event is on disk before the hook answers; the queue directory is the only source of truth.
- One applier per state file; on the producer path no lock is taken, no log line is written and the `zod` package is not
  loaded.
- The state file records which events it holds and which follow-up work is still owed, in the same atomic save.
- Slow work never delays applying events. Only a command asks for the applier's place, with a stop request that counts
  while the command is alive, waiting and touching it every 2 seconds; a worker leaves the place for such a request, for
  a record of a newer release, when idle, or for the tombstone, and never for another worker.
- Processes of two queue releases can take turns at the lock, so every name and format they read from each other is
  fixed in the first queue release, and later releases only add what an older release keeps when it saves and leaves
  owed when it cannot do it (3.5, 3.12).

### 2.2 Boundaries and responsibilities

| Part                      | Owns                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer (`hook` command) | Interpreting the payload in process (Plan 0002 rules), writing one record, starting a worker if needed                                        |
| Queue (`<state>.queue/`)  | Durable records; nothing else                                                                                                                 |
| Worker (`worker` command) | Applying records (apply lane) and owed follow-up work and publishing (follow-up lane)                                                         |
| Commands                  | `status`, `reset`, `flush`, `update`, `worker --stop`, `uninstall --all`: take over, then act                                                 |
| `@rivus/agent-kit-collab` | `acquireProcessLock` for the applier, `withStateLock` and the log lock; `isProcessLockHeld` for the producer's check of the worker lock (3.3) |

### 2.3 Main path

1. `hook` resolves the source, session, project and internal event name in process, writes a record (temporary file,
   then `rename`), starts a worker unless a process of its release or a newer one holds the worker lock (3.3), prints
   its output and exits.
2. The worker's apply lane lists the queue every 250 ms, applies the new records under the state lock, saves the state
   together with their ids and the follow-up work they owe, then deletes their files.
3. The follow-up lane works off owed dsh usage appends, per-source usage refreshes and the owed rendered sync, one at a
   time.
4. A command that changes state takes over from the worker (3.7), applies what is pending, and runs today's code.
5. After the idle interval with nothing pending, the worker exits (3.6).

### 2.4 Design decisions

| Decision            | Choice                                                                                                                                                                                                                                               | Rejected                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport           | One file per event, `rename` into the queue directory                                                                                                                                                                                                | Append-only file (rotation races); socket (loses events when nothing listens)                                                                                                           |
| Consumer lifetime   | Started on demand, exits when idle                                                                                                                                                                                                                   | System service (install, upgrade and uninstall surface on two platforms, always resident)                                                                                               |
| Exactly once        | Applied record ids, owed dsh appends and owed per-source refreshes saved with the state                                                                                                                                                              | Idempotent replay (fallback finish and reopen are not idempotent)                                                                                                                       |
| Cross-release state | `queueApplied` and `queueOwed` keep Q1's format; later releases only add keys and fields an older release can ignore, and every release parses them loosely, writes back what it does not know and leaves owed work it cannot do                     | A version stamp that makes an older holder skip its save and hand over (an older command, such as a deferred `flush` or a `reset` started before the upgrade, could then do nothing)    |
| Publishing          | Today's rendered sync, owed as one `renderedSync` flag that the sync's own locked save clears                                                                                                                                                        | A publish debt with its outcome (today's sync claims the interval before publishing, so a replay returns "debounced")                                                                   |
| Slow work           | A separate follow-up lane                                                                                                                                                                                                                            | One loop (a slow publish delays every event)                                                                                                                                            |
| Taking over         | A stop request, written only by a command, which stays alive while it waits and touches the request every 2 seconds, and which stops counting 6 seconds after its last touch; the holder stops within an iteration and leaves owed work in the state | Command records with results and deadlines (receipts and snapshots across lanes); stop requests from producers (the producer's pid is gone milliseconds later, so its request is stale) |
| Upgrade handover    | An older worker leaves when it lists a record with a higher `v`; the worker that record's producer started takes the lock                                                                                                                            | A stop request from the newer worker (newer workers started together yield to each other's requests and pass the lock back and forth)                                                   |
| Started workers     | Repeat the producer's check every 250 ms; exit once a holder of their release or a newer one has written its version; up to 60 seconds                                                                                                               | A fixed 5-second wait (a newer worker gives up behind an older command); yielding to same-release workers (the lock passes back and forth)                                              |
| Single applier      | `acquireProcessLock` on `<state>.worker.lock.db`, never deleted                                                                                                                                                                                      | PID file alone (stale after a crash); deleting the lock file (breaks mutual exclusion)                                                                                                  |
| Liveness check      | `isProcessLockHeld` on `<state>.worker.lock.db` (kit 0.14.0), which checks without taking the lock (3.3); the holder's record version in `<state>.worker.v`                                                                                          | `acquireProcessLock` with `wait: false` (takes a free lock on the hook path, about 125 ms against a held one); `<state>.worker.json` parsed by the producer (a schema on the hook path) |
| Record content      | Presence's normalized event                                                                                                                                                                                                                          | Raw payload (prompt text and tool arguments on disk, Spec S9)                                                                                                                           |
| Order               | `rename` is the recording point; a batch sorts by recorded time                                                                                                                                                                                      | A monotonic clock across processes (needs a boot identity the producer cannot get cheaply)                                                                                              |
| Uninstall           | A `<state>.disabled` tombstone that producers and workers honor until `setup`                                                                                                                                                                        | Waiting for the lock only (late hooks recreate the state)                                                                                                                               |
| Rollout             | The whole feature in one release, no mode switch                                                                                                                                                                                                     | A `direct`/`queue` switch (switching back can reorder pending events)                                                                                                                   |

## 3. Detailed design

### 3.1 Entry points

- `agent-presence hook ...`: every installed form (`--source/--event`, `--agent`) becomes the producer. Interpretation is
  Plan 0002 batch 4's; only the application moves to the worker.
- `agent-presence worker`: a new command, not shown in help, started detached by producers, commands and workers that
  stop for a stop request (3.3, 3.6), with the pattern `deferred-update.ts:8-24` already uses.
  `agent-presence worker --stop` takes over, applies what is pending and exits.
- `status`, `reset`, `flush`, `update`, `uninstall --all`: 3.7 and 3.8.

### 3.2 Records

- Location: `<state file>.queue/` (mode 0700), so every state file has its own queue and worker. File name
  `<recordedAt, 13 digits>-<pid>-<4 random hex>.json` (mode 0600), written as `.tmp-<name>` and renamed. The worker
  removes `.tmp-*` files older than one hour.
- Variants, all with `v` (record version), `id` (the file name without extension), `recordedAt` (wall-clock ms) and
  `epoch` (the number the producer read from `<state>.epoch` before its tombstone check, 3.3 and 3.8; `0` while that file
  does not exist, as on a first install before any `setup` removed a tombstone):

  | `kind`  | Fields                                                                                                                                         |
  | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
  | `event` | `source`, `event` (presence's internal name), `sessionId`, `project`, `subagent` (`id`, `type`), `usage` (dsh only), `scanEnv`, `payloadKeys`  |
  | `skip`  | `code` (open, like an error's: `missing-session-id`, `no-presence-source`, `ignored-event`), `source` or `agent`, `nativeEvent`, `payloadKeys` |
  | `error` | `code` (for example `handler-refused`, `resolver-failed`, `hook-load-failed`), `source` if known, a message without payload values             |
  - `usage` holds the normalized dsh usage event: `model` (a model name, needed for pricing, `src/usage/pricing.ts:122-128`)
    and the token and cost numbers (`src/usage-events.ts:63-71`); nothing else from the payload.
  - `scanEnv` holds the environment values that locate the source's transcripts (for example `CLAUDE_CONFIG_DIR`); Q1
    inventories them from the scanners (`CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `XDG_DATA_HOME`) and lists their names
    next to the resolvers in `src/cli/hook-context.ts`, so the producer copies them without loading a scanner (below).
    Until Plan 0002 batch 2, the scanners import the same list from there and read their variables only through it.
    From batch 2 on, the kit's `scanUsage` reads the catalog's agent-home variables from the platform's `env` instead,
    so batch 2 grows the list to those variables for the agents it scans, and the worker builds that `env` from the
    record's `scanEnv`. Either way, a variable a scan reads is always one the producer copies. It is set on boundary
    events only and never carries credentials.
  - `payloadKeys` holds key names, for the diagnostic log.
  - A `skip` record's `code` is any non-empty string, as an `error` record's is: a later release may skip for a reason
    of its own without raising `v`, and an older applier only logs a code it does not know.

- `v` increases on an incompatible change, and when a release adds a kind of owed work or a built-in source (3.5). A
  worker applies every record with its own `v` or a lower one, and never one with a higher `v`: it hands over to a
  newer worker instead (3.7).
- An applier (the worker or a command that took over, never the producer) parses a record once when it reads it, with
  zod/mini schemas; no hand-written shape checks. It first parses `v` alone, with a schema of just that field, and leaves
  a record with a higher `v` in place without parsing the rest (3.5), so an older worker never moves a newer release's
  record to the failed records; then it parses the record with the schema for its `kind`. A record that fails either
  schema is a bad record (3.10).
- No schema is in the hook's import graph: loading the `zod` package costs about 22 ms per run (importing `/node` and
  `/process-lock` took 22 ms less once agent-kit#78 stopped loading it, agent-kit#74), against the 85 ms target (1.3).
  The record schemas, the state-field schemas (3.5) and the dsh usage line schema (3.5) live in modules that only the
  worker and the commands import. The producer writes records through a module that imports no schema module (record
  types come through type-only imports, which are erased), and its own reads use none: `<state>.epoch` and
  `<state>.worker.v` are decimal text read as numbers, the tombstone is an existence check, and whether a worker runs
  comes from the kit's `isProcessLockHeld` (3.3). `usageEventFromPayload`, which the producer uses for dsh usage, stays
  in a module without a schema.
- The producer resolves sources through `src/sources.ts`, which imports the built-in source table
  (`BUILTIN_SOURCE_PLUGINS` in `src/cli/hook-context.ts`). Today that table pairs each resolver with its scanner, and
  the dsh scanner (`src/usage/scan-dsh.ts`) imports the dsh usage reader, which is where the dsh line schema goes. So
  the table is split: `src/cli/hook-context.ts` keeps the built-in resolvers and imports no scanner, and the built-in
  scanners move to a scanner table in `src/usage/billable-sources.ts`, together with `billableSources` (moved out of
  `src/sources.ts`), which only the usage command and the usage refresh import. The hook-graph test enforces all of
  this: `zod` never goes on its allowlist, and the schema, state-store, dsh log, scanner table and scanner modules are
  among its forbidden modules (6.3).

### 3.3 Recording and starting a worker

The producer takes no lock, and its own reads use no schema (3.2). In order, it:

1. Reads `<state>.epoch` as decimal text (3.8).
2. Checks whether `<state>.disabled` exists (3.8); if it does, it records nothing. The epoch is read first because a
   producer that checked the tombstone first could pass the check just before `uninstall --all`, pause, then read the
   epoch that the next `setup` increased and write a record that appliers accept, against Spec S10. Read first, the
   epoch is the old one, and appliers delete the record unapplied.
3. Writes its record (3.2).
4. Checks with `isProcessLockHeld` whether a process holds `<state>.worker.lock.db`, without taking the lock. If none
   does, it starts a worker. If one does, it reads `<state>.worker.v` as decimal text, which counts as `0`, like the
   epoch, when the file is missing or its text is not a non-negative integer; if that version is lower than its own
   record version, it starts a worker. It writes no stop request.

- Every process that holds the lock, a worker or a command, writes its record version to `<state>.worker.v` (decimal
  text, temporary file and `rename`) right after it takes the lock, and deletes the file right before it releases the
  lock (3.6). So a producer that finds the lock held reads the holder's version, or `0` while the holder has not
  written it yet. A holder whose version is at least the record's lists the queue after the producer's rename, a worker
  every 250 ms and a command once more when it leaves (3.6), and applies the record. A lower version, or `0`, makes the
  producer start a worker; when the holder is of the producer's release and has not written its version yet, that
  worker is not needed and leaves on its own (below). The deletion matters when a process of an older release (3.12)
  takes the lock after a newer worker left: without it, a newer producer that checks in the older holder's first
  milliseconds would read the newer worker's version and start no worker, and the older holder cannot apply its record
  (3.7).
- A producer writes no stop request. A request counts only while the pid in it is alive (3.7), and the producer exits
  milliseconds after its check, so every holder would ignore its request. Nor does the producer need one: a holder of
  an older release leaves when it lists the producer's record (3.7), and a holder of the producer's release or a newer
  one applies it.
- A worker started by a producer, or by a command or a yielding worker as it leaves (3.6), repeats the producer's check
  every 250 ms for up to 60 seconds. Each round it exits if `<state>.disabled` exists (3.8); otherwise:
  - while a live stop request exists (3.7), it does nothing that round, so it never takes the lock in front of a
    waiting command;
  - when the lock is free, it tries to take it with `wait: false`; if that succeeds, it writes `<state>.worker.v` and
    runs as the worker;
  - when the lock is held and `<state>.worker.v` shows its own version or a higher one, it exits: that holder applies
    every record the started worker could apply (above);
  - when the lock is held and `<state>.worker.v` shows a lower version or `0`, it waits for the next round.

  So of the workers that a burst starts, one takes the lock and the others exit in the round after it has written its
  version. No worker yields to another, so the lock is not passed back and forth. A worker newer than the holder keeps
  trying: an older worker leaves within about a second of listing a newer record (3.7), and an older command when its
  run ends. The 60-second limit ends the wait behind a stuck holder. When commands of an older release (3.12 lists
  where they come from) hold the lock longer, one alone or several one after another, the newer records wait for a
  later hook or command; section 7 has this for the owner to confirm. The worker checks before it tries because a
  failed `wait: false` try against a held lock costs about 125 ms (below).

- A worker crash releases the lock at once (the kernel drops the SQLite lock), so the next producer finds it free and
  starts a worker. A crash right after a producer found the lock held leaves that producer's record pending until a
  later hook or command (Spec). A holder that crashes or is killed leaves `<state>.worker.v` behind; the next holder
  overwrites it right after taking the lock, and a producer or started worker that finds the lock free does not read
  it. A newer producer or started worker that checks in the milliseconds before that holder writes its version reads
  the crashed holder's version; if the next holder is of an older release, it hands the newer record over with no
  newer worker waiting, and the record waits for a later hook or command. This needs a crash, an older release's
  process taking the lock next, and a newer record checked within those milliseconds; section 7 has it for the owner to
  confirm, with the older-command case above. A command that holds the lock and is killed, for example by a signal,
  releases it the same way but skips its exit order (3.6), so the records pending when it dies, among them every record
  a producer renamed after the command's takeover listing, stay pending until a later hook or command. That window is
  the rest of the command's run, seconds, while the worker crash that section 7 accepts can strand only a record
  renamed within the apply-lane interval before the crash (about 250 ms). So the killed command is a separate section 7
  item for the owner to confirm.
- Step 4 uses `isProcessLockHeld(platform, path)` from `@rivus/agent-kit-collab/process-lock`, which kit 0.14.0 added
  for this (agent-kit#106, section 7). The kit's Node platform always provides SQLite, so the check stats the file (a
  missing file reads as free and is not created), opens it read-only with `busy_timeout = 0` and runs one statement
  under a shared lock: it never takes the lock, writes no `<path>.holder`, reads no process identity, and checks
  running at once do not see each other as holders. An acquisition's first attempt waits out a check, so the idle-exit
  retake, a started worker's tries and a waiting command's tries, all with `wait: false` (3.6, 3.7, above), still get
  a free lock. The kit's caveat, that the later retries of a `wait: true` acquisition can find the lock busy while a
  check reads it, does not arise: no applier waits with `wait: true`. The answer can
  be stale when it arrives; only the acquisition decides who holds the lock, and the exit order (3.6) covers a holder
  that leaves right after a check.
- `acquireProcessLock` with `wait: false` cannot stand in for the check. When the lock is free, it takes it and writes
  `<path>.holder`, which puts a lock back on the hook path. When the lock is held, it returns only after its first
  attempt's settle retries, five tries with a 10 ms SQLite busy timeout and four pauses of 5-25 ms: about 125 ms (median
  of 20, 99-143 ms) in a `node:sqlite` reproduction of that attempt on macOS, more than the whole 85 ms target. And
  every call reads the process identity first (`sysctl` and `ps` on macOS, about 7 ms, 1.1).

### 3.4 Order

- The recording point is the `rename`. A command hook exits only after its `rename`, and the agent starts its next hook
  for that session after the previous one exits, so sequential events have increasing `recordedAt` unless the system
  clock steps backwards, and the later one is never applied in an earlier batch.
- Each batch is applied sorted by `recordedAt`, then by file name. Events recorded concurrently (opencode and Pi bridges
  that do not wait, parallel tool calls) have no defined order, as today.

### 3.5 Applying exactly once

The state file gains two optional fields, parsed with zod/mini schemas when the state is loaded, in the state-store
module that the hook graph does not reach (3.2, 6.3); an invalid value loads as absent, never as a failed load.
Releases before the queue drop them (1.1). Every queue release loads and saves them, so Q1 fixes their format:

- `queueApplied`: ids of applied records whose files may still exist.
- `queueOwed`: `dshUsage` (usage events still to append, each with its record id), `usageRefresh` (one entry per source
  and `scanEnv`, with the latest boundary time and a generation number that increases whenever a newer boundary updates
  the entry), and `renderedSync` (set when applied events changed what the slot renders and no sync has run since).

A process of an older queue release can take the lock after a newer one and save the state (3.12). So a later release
only adds to these fields, and every release keeps what it does not know:

- Adding: a later release adds a key in `queueOwed` for a new kind of owed work, or a field that an older release can
  ignore while it updates the entry or works it off, on an entry or on an object inside one (a `dshUsage` entry's
  `usage`, an entry's `scanEnv`), so those objects only grow. It never changes or removes a field. A field that an
  older release cannot ignore while it works off the entry, such as a count it must add, or a new `scanEnv` variable
  read by a scanner the older release also has, goes only into a new kind of owed work. A later release
  reads entries that an older holder created without its new fields, so those fields are optional in its schemas.
- Keeping: the schemas parse `queueOwed`, each of its entries and every object inside an entry with zod/mini's
  `looseObject`, so keys and fields a release does not know are kept verbatim and written back on every save. A release
  that changes a known entry, for example increases its generation, changes the parsed entry in place and never builds
  a new object for it, so the entry keeps its unknown fields; the dsh append writes an entry's `usage` as parsed, unknown
  fields included. A boundary updates the `usageRefresh` entry whose `source` and whole `scanEnv`, keys it does not
  know included and in any key order, equal its own, so an older release never merges entries a newer release keeps
  apart.
- Working off: a release works off only the owed work it can do, which is every entry of the kinds it knows except a
  `usageRefresh` entry whose source is not in its merged source table (its built-in sources and the sources in the
  configuration file, `src/sources.ts`). It leaves the rest owed and untouched, and that work neither keeps it from its
  idle exit nor makes it start a worker when it leaves (3.6). Without the exception, an older release would remove,
  as done, the refresh of a built-in source that a later release added: the refresh returns at once for a source it
  has no scanner for (`src/cli/usage-badge.ts:79-81`), which reads as completed. The source table decides, not the
  scanner table, because a source without a scanner (`grok`, a source configured with a handler) still owes its refresh: on the first
  boundary of a day it refreshes every built-in (`usage-badge.ts:71-79`). An entry for a source since removed from the
  configuration file stays owed in every release; it changes nothing but the state's size (inferred). A later release
  that gives a scanner to a source an earlier queue release has without one owes that source's refreshes under a new
  kind of owed work, since the earlier release would work them off without scanning.

An older holder therefore neither drops a newer release's owed work, nor removes as done work it cannot do, nor applies
again a record whose id a newer holder saved in `queueApplied`. A release that adds a kind of owed work or a built-in
source also raises `v` (3.2), so its producers' records make an older worker leave (3.7) and a worker of that release
take over, with the owed work the older worker left. Other state fields keep today's rule (older releases drop fields
they do not know, 1.1), so applied ids and owed work never go into a new top-level field.

Apply lane, every 250 ms, until the worker must stop (3.7):

1. List the queue; delete files whose ids are in `queueApplied`; read the rest, stopping at a record with a higher `v`,
   in which case the worker hands over once steps 2 and 3 are done for the records before it (3.7).
2. Under `withStateLock`: load the state; apply each record in order with its recorded time (`applyAgentEvent` and the
   session expiry the hook applies today; `skip` and `error` records change nothing); add the ids to `queueApplied`; add
   owed work: a dsh append per usage-bearing event, for each boundary event the refresh entry of its source and `scanEnv`
   (created or updated, generation increased), and `renderedSync` when an `event` record was applied; save once.
3. Delete the applied files; at the next save, drop from `queueApplied` the ids whose files no longer exist.

Follow-up lane, one item at a time, concurrently with the apply lane, checking between items whether the worker must
stop (3.7):

- dsh usage append: through the retained-log append, but waiting until it holds the log lock instead of skipping (the
  lane is off the hook path), with the record id in the entry. The wait takes the lane's abort signal
  (`acquireProcessLock`'s `signal`), so a stuck log-lock holder cannot keep the worker from handing over; an aborted
  append stays owed. The dsh usage scanner reads the optional `id` through its zod/mini line schema, which replaces the
  hand-written `asUsageEvent` (`src/usage-events.ts:75-92`) in a module the hook graph does not reach (3.2), and skips a
  repeated id. The item leaves `queueOwed` only after the append wrote.
- Usage refresh: through the existing refresh for that source, with its `scanEnv` and boundary time so the day rule
  (`usage-badge.ts:71-79`) holds; an entry whose source is not in the merged source table is skipped and stays owed
  (above). The scanners read their transcript roots from the worker's environment with every variable that the
  entry's built-in source reads, or that the entry recorded, set to the recorded value, or unset when none was
  recorded. The refresh gains an abort signal and returns whether it completed. In the refresh's own locked save, the
  entry is removed only if its generation is still the one the refresh started with; a boundary that arrived during
  the scan keeps it owed. A refresh that completes without saving (nothing to scan, or a failed scan that keeps the
  cache) removes the entry the same way in a save of its own.
- Rendered sync: when `renderedSync` is set, today's `syncRenderedSlotWithDeferredFlush` runs once with the worker's
  clock. It publishes or schedules the deferred flush exactly as the hook does today. `renderedSync` is cleared in the
  locked save that records the publish's success when the state still renders the published value (records applied
  during the publish that render another value keep it), in the save that schedules the deferred flush or finds one
  due in time, or when the sync finds nothing to publish; a rollback after a failed or aborted publish keeps it. So if
  the worker dies or hands over before the publish finished, the next applier runs the sync again; when the
  interrupted publish already claimed the interval, that sync schedules the forced publish one debounce interval later.
  Commands' rendered syncs clear it by the same rules; `update --value` publishes no rendered value and leaves it.
- A usage refresh that completed and saved sets `renderedSync` again in that save, because it changes what the slot
  renders.
- An item that fails is not tried again by the same applier until new work for it is owed: a failed sync until an
  applied event or a refresh owes a sync again, a refresh until a boundary updates its entry, a dsh append not at all;
  the next applier tries each again. So a provider that keeps failing cannot keep a worker busy, and an item set aside
  this way does not keep the worker from its idle exit, though it counts as owed work when a holder leaves (3.6).

A live stop request, or a record with a higher `v` (3.7), aborts the item in progress through its abort signal (the dsh
append's wait for the log lock, the refresh's scans, the publish's request), so the holder stops within about a second;
an aborted item stays owed. The holder releases the lock only after the apply lane's current batch has saved or been
dropped and the follow-up item has ended, with any rollback it triggers saved, so no write of the old holder lands
after the new holder starts.

### 3.6 Leaving the lock and idle exit

A worker leaves after the idle interval with an empty queue and no owed work it can do (3.5), when it must stop
(3.7), when it finds the tombstone (3.8), or when applying keeps failing for a whole idle interval (3.10); a command
leaves when its run ends, whether it succeeded or failed. Every holder leaves in this order:

1. Note whether owed work it can do (3.5) remains, then delete `<state>.worker.v` (3.3).
2. Release the lock.
3. List the queue once more, then:
   - a worker after the idle interval: if no record is there, exit. Otherwise, if a live stop request exists (3.7),
     continue as a started worker (3.3), which makes no try while the request is live. If none exists, take the lock
     again with `wait: false`: if that succeeds, rewrite `<state>.worker.v` and continue as the worker; if another
     process holds the lock by now, continue as a started worker;
   - a command, or a worker that stopped for a stop request: start a worker if owed work remained or a record is there,
     then exit;
   - a worker that stopped for a record with a higher `v` (3.7) or for the tombstone, `uninstall --all` and
     `worker --stop`: exit without starting a worker.

Nothing slow runs after step 2, and nothing is written after it unless the idle worker takes the lock again.

A producer renames its record, then checks the lock (3.3). A record renamed before step 3's listing is seen there. One
renamed after it is followed by a check that runs after step 2. That check finds the lock free, so the producer starts a
worker, or held by a later holder, whose version decides (3.3): a holder of the record's release or a newer one lists
the queue after taking the lock (a worker) or once more when it leaves (a command), which also covers a record renamed
after a command's own takeover listing; an older or unwritten version makes the producer start a worker, which waits for
the lock. A scheduled publish is already held by the deferred flush the sync spawned.

A command starts a worker after its last listing because a producer that renamed its record while the command held the
lock read the command's version and started no worker, and renamed the record before that listing, which sees it. A
worker that stopped for a stop request starts one for the same reason. That worker makes no try while the request is
live (3.3), so it does not take the lock in front of the requester. Once the requester holds the lock and has written
its version, the started worker exits if that version is at least its own; otherwise the requester is of an older
release and cannot apply the newer records, and the started worker waits for it to leave. If the requester dies before
it takes the lock, its request no longer counts, and the started worker takes the lock.

An idle worker that loses the retake keeps trying as a started worker for the same reason: the process that took the
lock may be of an older release (3.3). An idle worker that finds a live request makes no retake, so it does not take the
lock in front of the waiting command; if its retake ran just before the request was written, it stops at its first
iteration (3.7).

A worker that stopped for a record with a higher `v` starts no worker: a worker it started would be of its own, older
release and would stop again as soon as it listed that record. The record's producer read the older version and started
a worker of its own release, which waits for the lock (3.3).

### 3.7 Taking over

- Only a command asks for the applier's place. It writes its own request file `<state>.worker.stop.<token>` holding its
  pid and waits for the lock up to 10 seconds in every release: every 50 ms it checks the lock with `isProcessLockHeld`
  and, when it is free, tries once with `wait: false`, as a started worker does (3.3), so every try is an acquisition's
  first attempt and none pays a try against a held lock. While it waits, it touches the file
  (sets its modification time to now) every 2 seconds and writes it again, with the same name and pid, if the file is
  gone. When it gets the lock or gives up, it stops touching the file, then deletes it. It stays alive for its whole
  wait, so its request counts exactly while it waits. A request is live while its pid is alive and its file's
  modification time is within 6 seconds of the reader's clock, before or after it (three touch periods); otherwise it
  is stale, and any process that finds it deletes it and ignores it.
- The touches are there because the age check compares the reader's wall clock with the file's modification time, while
  the command times its wait with a timer. If the system sleeps or the clock is set forward during the wait, a holder or
  started worker can judge a live request stale and delete it. The command then writes it again at its next touch, so
  the holder stops about one touch period later. Without the touches the holder would keep the lock, and the command
  would time out; a deferred `flush` would lose the publish it was scheduled for. A clock set backwards does the same
  through a modification time ahead of the reader's clock; the bound applies in both directions so that a killed
  command's file becomes stale then too.
- The age bound covers a command killed while it waits, for example the shutdown watcher's `reset` at power-off: its
  file stays, no one touches it, and once its pid belongs to another long-lived process (after a restart, for example),
  the request would otherwise keep every worker from the lock (3.3) and make every holder stop. Producers and workers
  write no request: a producer's would be stale milliseconds after it was written (3.3), and no worker needs another
  worker's place.
- A worker that holds the lock stops at its next apply-lane iteration when it finds a live request, or when its
  apply-lane listing reaches a record with a higher `v` (3.5); the iteration aborts the follow-up item in progress, and
  the worker leaves (3.6). It never stops for another worker. Started workers and an idle worker's retake make no try
  for the lock while a request is live (3.3, 3.6), so the lock goes to the command; a worker that took the lock just
  before the request appeared stops at its first iteration. A command that holds the lock does not yield to requests:
  it keeps the lock for its own bounded run and releases it when it leaves; a second command waits for it.
- A worker that stops for a record with a higher `v`, an older worker after an upgrade between queue releases, first
  applies and saves the records listed before that one, so order holds, and leaves without starting a worker (3.6). The
  record's producer read the older version in `<state>.worker.v` and started a worker of its own release (3.3), which
  takes the lock once the older worker has released it and applies that record and the ones after it, older ones
  included (3.2). This needs no request and no pid: the older worker decides from the records it lists every 250 ms
  anyway. The first release with the queue has this rule, so every later upgrade between queue releases can rely on it
  (3.12).
- The command, holding the lock, stops touching its request, deletes it and writes `<state>.worker.v` (3.3), then:
  - `status`, `flush` and `update` apply the pending records and append the owed dsh usage (apply-lane steps 1-3 and the
    dsh items), then run today's command code; `flush` and `update` clear `renderedSync` through their own sync;
  - `reset` applies the pending records only, finishes every session and publishes, clearing `renderedSync`; its time is
    bounded by the takeover wait, one in-memory pass with one save over the pending records, the credential read and
    publish timeouts, and exiting (it waits for no background work it started) (Spec S6);
  - `worker --stop`: 3.8.

  Like every applier, a command stops applying at the first record with a higher `v` (3.5). So a command of an older
  release (3.12) runs its own code without the newer records, which a newer worker applies after it; for an older
  `reset`, a newer `SessionStart` pending at its takeover is applied after it finished every session, and that session
  is running afterwards. Section 7 has this for the owner to confirm (Spec).

- Every lock holder leaves in 3.6's order, commands included, whether they succeeded or failed. A producer that renamed
  its record while the command held the lock started no worker (3.3); the command's last listing is what gets that
  record applied (3.6). This covers `status`, `reset`, `flush`, `update` and `setup` after it removed a tombstone (3.8);
  `uninstall --all` and `worker --stop` leave the tombstone in place and start no worker.
- The shutdown watcher runs `reset --force --silent` and waits for it without a deadline, so the bound above is the
  shutdown delay. `--silent` keeps its meaning.
- A command that cannot take the lock within its wait fails as a command failure does today.
- The request file's name, its decimal pid, the 2-second touch while the command waits and the 6-second age bound are
  among the names and formats every queue release keeps (3.12).

### 3.8 Uninstall and setup

- `<state>.epoch` holds a number that producers copy into each record; workers and commands apply only records whose
  epoch matches the file. `setup`, when it removes a tombstone, increases it. Producers and appliers read it alike, as
  decimal text without a schema (3.2): a missing file, or text that is not a non-negative integer, counts as `0`, so a
  first install records and applies epoch `0`, and the first increase writes `1`.
- `<state>.disabled` is a tombstone. Producers check it after reading the epoch and before recording (3.3), workers
  before starting, at every round while they wait for the lock (3.3) and at every iteration, and `status`, `reset`,
  `flush` and `update` right after taking over. While it exists, producers record nothing, workers exit, and those
  commands change nothing.
- `uninstall --all` writes the tombstone, takes over, deletes the queue directory, the stop-request files and
  `<state>.worker.v`, then the state as today. It keeps `<state>.worker.lock.db` and `<state>.epoch`. The lock's
  `<state>.worker.lock.db.holder` is the kit's: written when `uninstall --all` takes the lock and deleted by the kit's
  `release()` when it releases it, so none is left after a normal exit. A producer that passed its tombstone check just
  before can still write one record afterwards; nothing applies it while the tombstone exists, and after `setup` its
  old epoch makes every applier delete it unapplied.
- `worker --stop` takes over, applies the pending records, works off the owed items, writes the tombstone and exits. From
  then on new-release hooks record nothing and no new-release worker starts, so the previous release can be installed. A
  previous release from before the queue ignores the tombstone and the queue. A previous release with the queue honors
  the tombstone like the new one, so its hooks record nothing and no worker of it starts until its own `setup` runs,
  which deletes the tombstone and the records left behind (next bullet).
- `setup` of any queue release, when it finds the tombstone, takes over, deletes every record in the queue (each was
  recorded before or around an uninstall or a downgrade) and then the tombstone. Without a tombstone it leaves the queue
  alone.
- `uninstall` without `--all` changes none of these; the worker exits when idle.

### 3.9 Configuration and credentials

- One state file, one configuration. The worker reads the configuration file before each batch and uses the environment
  it was started with for credentials (`src/secret.ts:41-57`) and provider overrides. A hook or a command that took
  over (3.7) starts a worker with its own environment, and a worker that stopped for a stop request passes its
  environment on to the worker it starts (3.6), so every worker's environment is that of a hook or of a command that
  took over. A hook or command whose environment differs (another credential, another state or config path) for the
  same state file is not supported; section 7.
- Transcript roots travel with boundary events in `scanEnv`.
- Records never carry credentials.

### 3.10 Failures

| Failure                  | Behavior                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record cannot be written | The hook prints its output and exits 0; the event is lost (Spec S8)                                                                                                                                                                                                                                |
| Worker cannot be started | Records wait; the next producer tries again                                                                                                                                                                                                                                                        |
| Worker killed            | The kernel releases the SQLite lock; `queueApplied` and `queueOwed` finish the work (Spec S4)                                                                                                                                                                                                      |
| Worker stuck             | It keeps the lock, so producers start no other worker; takeovers time out and commands fail; records wait; section 7                                                                                                                                                                               |
| Bad record               | Moved to `<state>.queue/failed/` (kept 7 days), logged, skipped                                                                                                                                                                                                                                    |
| Applying keeps failing   | Retried every iteration; after a whole idle interval of failures the worker leaves, starting no worker; records wait                                                                                                                                                                               |
| Large backlog            | Nothing is dropped; above 10,000 records the worker logs a warning                                                                                                                                                                                                                                 |
| External call hangs      | Scans take an abort signal, and each provider publish takes the caller's abort signal combined with a 30-second timeout (`AbortSignal.any` with `AbortSignal.timeout`), so a hanging provider cannot hold the applier and a timed-out publish counts as a failed attempt; the apply lane continues |

### 3.11 Logs

The producer writes no log line. Source resolution returns its diagnostics instead of writing them, and the producer
records them as `error` records; the hook-module load fallback records an `error` record, and if recording fails too it
only prints the output. The worker writes the diagnostic line for each event (payload key names), the line the hook
writes today for each `skip` and `error` record, and `worker.start`, `worker.exit` with its reason (idle, a stop
request, a record with a higher `v`, the tombstone, a holder of its release or a newer one, the 60-second limit, or
applying failing for a whole idle interval, 3.3, 3.6, 3.10), batch sizes, failed records and backlog warnings. The lines
of one batch's records go into one append, so a batch takes the log lock once.

### 3.12 Compatibility and migration

- Upgrading from a release before the queue: uninstall that release with its own `agent-presence uninstall`, which
  removes the hooks it installed at whatever paths it used, then install the new release and run `setup`. The new release
  does not handle a previous release running alongside it.
- A deferred flush that the previous release scheduled before its uninstall (`deferred-update.ts:9-24`) is a detached
  timer the uninstall does not stop. It still runs that release's `flush` when due, and its retries while the provider
  rate-limits it (`deferred-update.ts:78-87`); it ignores the queue and the tombstone, and each of its saves drops
  `queueApplied` and `queueOwed`, so at most the records of one batch can be applied twice and the owed items of that
  moment are lost. Decided (owner, 2026-10-13): this is not handled.
- Upgrades between releases that both have the queue need no step: the older worker leaves when it lists a record of
  the newer release, and the worker that record's producer started takes over (3.3, 3.7). The newer release applies
  every older record version, so it continues where the older worker stopped.
- Processes of both releases can still take turns at the lock after such an upgrade. An older process holds it next
  when it is a command that was already running, a deferred `flush` the older worker scheduled (it runs the scheduling
  process's own release, `process.argv[1]` at `deferred-update.ts:9`, after the debounce interval and again while the
  provider rate-limits it), a worker such a process starts when it leaves (3.6), or a command the user runs from another
  installed release. The hooks run the installed release, and so does the shutdown watcher's `reset` once both go
  through the stable shim (Plan 0002 3.5; inferred: both commands come from `buildAgentPresenceShellCommand`,
  `src/installers.ts`, `src/power-watcher.ts`). So every queue release keeps these names and formats, which processes
  of different releases read from each other:
  - the queue directory `<state>.queue/` and its record file names (3.2), whose leading `recordedAt` and whole name are
    the sort key (3.4) and whose name without the extension is the record id; the `.tmp-` prefix of files being
    written and `failed/` (3.10);
  - a record's `v`, a top-level non-negative integer that an applier parses before anything else (3.2);
  - `<state>.epoch` (decimal text) and `<state>.disabled` (an existence check), 3.8;
  - `<state>.worker.lock.db` with the kit's SQLite lock on it, so a later release pins only kit versions whose lock on
    that file excludes the earlier kit's (inferred), and `<state>.worker.v` (decimal text), 3.3;
  - the stop request files `<state>.worker.stop.<token>` (a decimal pid; touched every 2 seconds while its command
    waits and written again if gone; live while that pid is alive and the file's modification time is within 6 seconds
    of the reader's clock), 3.7;
  - the state lock `<state>.lock.db` and the log locks `<log>.lock.db` next to each log (`agent-presence.log.lock.db`
    and `usage-events.log.lock.db` by default, Plan 0002 3.1), whose paths both releases must share for their locks to
    exclude each other, and the record id in a dsh usage line (3.5);
  - the state fields `queueApplied` and `queueOwed`, which later releases only add to and every release writes back
    with what it does not know, and the rule that a release works off only the owed work it can do (3.5).

  What an older command does then: it applies the records of its own `v` or lower and stops at the first newer one
  (3.5), works off the owed work it can do, runs its own code, saves the state with the newer release's keys and fields
  unchanged, and leaves (3.6). The newer records and the owed work only the newer release can do wait for a newer
  worker, which the producer of a newer record starts when it reads the older holder's version (3.3); an older worker
  that holds the lock exits when idle with that work pending (3.6). The effects this has on the Spec are in section 7
  for the owner to confirm: an older `reset` ordered before newer records (3.7), newer records waiting behind older
  commands that hold the lock longer than 60 seconds or behind an older process that takes the lock right after a
  crash (3.3), and owed work only the newer release can do waiting while older processes hold the lock (3.5, 3.6).

- Downgrade: `agent-presence worker --stop` with the new release, then install the previous release. A release from
  before the queue ignores the queue and the worker files. A release with the queue honors the tombstone that
  `worker --stop` wrote (3.8), so after installing it run its `setup`, which deletes the tombstone and the records left
  behind; until then its hooks record nothing. Skipping `worker --stop` when downgrading to an older release that has
  the queue leaves records that release cannot apply: its workers hand over at the first one and apply nothing after it
  (3.7), and each hook starts a worker that leaves at once, until the newer release's `worker --stop` runs.

### 3.13 Security and privacy

- Records carry the fields in 3.2 only (Spec S9), in a 0700 directory with 0600 files, deleted once applied; failed
  records keep the same fields for 7 days.
- The worker runs as the user and listens on nothing.

## 4. Rollout and stability

### 4.1 Gates and rollout stages

The queue, the producer, the worker, the takeover by commands, the tombstone and `worker --stop` ship together in one
release (Q1). There is no mode switch. That release is the one that ships Plan 0002 batch 5 (Plan 0002 ships no release
before batch 5, its 4.1), so one upgrade, uninstalling the previous release first (3.12), covers both.

### 4.2 Signals and alerts

The worker's log lines (3.11). `status` output does not change.

### 4.3 Rollback

`agent-presence worker --stop`, then downgrade to the previous release, and run that release's `setup` when it has the
queue (3.12).

## 5. Verification

### 5.1 Functional checks

- Record codec, writer and sorter; interpretation to record, one case per row of Plan 0002's event table.
- Parsing: every malformed record (each `kind` with a missing or mistyped field, unknown `kind`, invalid JSON) is
  rejected as a bad record, and a record with a higher `v` is left in place; a state file with a malformed `queueOwed`
  (or `queueApplied`) loads with that field absent. A `queueOwed` with a key, entry fields, and fields inside a
  `dshUsage` entry's `usage` and an entry's `scanEnv` that the release does not know, written as a later release would
  write them, loads, and the next save writes them back unchanged next to the release's own changes (3.5).
- An older release modifies a known entry that has unknown fields and keeps them: a boundary that increases the
  generation of a `usageRefresh` entry with an unknown field leaves that field in the saved entry, and the dsh append of
  an entry whose `usage` has an unknown field writes that field into the dsh usage line (3.5).
- The 67-case event table from Plan 0002 batch 4, run through producer and worker: every case ends in the state the direct
  path produces.
- Publishing with a fake clock: an event outside the interval publishes, one inside it schedules the forced flush one
  interval later, `skip` and `error` records publish nothing, and a forced `reset` publishes at once.

### 5.2 Failure and retry checks

- SIGKILL the worker after reading, after the save, after deleting files, during a usage refresh and during a dsh append:
  every event applied once, every dsh usage event appended once, every owed refresh done once (Spec S4).
- Fallback finish and reopen recorded, worker killed after the save and before deleting files: the second worker does not
  apply them again.
- A dsh append with the usage-events file held by another writer waits and writes; a compaction during the wait keeps the
  line.
- A boundary arriving during a refresh of its source keeps the refresh owed (generation check).
- A command takes over while started workers wait: they make no try while its request is live, the holder stops, and
  the command takes the lock next; a worker that took the lock just before the request appeared stops at its first
  iteration. The worker that the stopped holder starts exits once the command has written its version; if the command
  is killed while it waits, that worker takes the lock and applies the records.
- A stop request file with a live pid and a modification time more than 6 seconds before or after the reader's clock is
  stale: a started worker deletes it and takes the lock, and a holder that finds it does not stop (3.7).
- A waiting command on the injected clock touches its request every 2 seconds. With the wall clock moved forward past
  the bound during its wait (as after a sleep), the holder deletes the request as stale and keeps working; the command
  writes it again at its next touch, the holder stops at its next iteration, and the command takes the lock within its
  wait. After the command gets the lock or gives up, no request file is left (3.7).
- `<state>.worker.v` holds the holder's version while a worker or a command holds the lock, and is gone after each way
  of leaving (3.6); after a SIGKILL it stays, and the next holder overwrites it.
- Started workers on the injected clock: one that finds the lock held by an older version for more than 60 seconds
  exits with the 60-second reason without taking the lock, and the record is applied by the worker the next hook
  starts; one that waits for the lock exits when `<state>.disabled` appears, without taking the lock (3.3).
- An idle worker that loses its retake to a worker of an older release keeps trying and applies its records once the
  older worker has left. An idle worker whose last listing finds a record while a command waits with a live request
  makes no retake and continues as a started worker; the command takes the lock next, and the idle worker exits once
  the command has written its version (3.6).
- A command that fails after taking over starts a background worker when records or owed work remain.
- Idle-exit race: producers recording while a worker exits, and while a command that took over (`status`, `flush`) holds
  the lock and exits, 100 iterations each by default and 1,000 by setting `PRESENCE_RACE_RUNS=1000`, which a release
  runs before it ships: no record stays.
- A worker killed while a producer writes: the next hook starts a worker.
- A takeover while a slow refresh runs: the holder stops within about a second, and the refresh stays owed.
- Twenty workers started together: one takes the lock, and the others exit in the round after it has written its
  version without taking it. A corrupt record; a read-only queue directory (Spec S8); a hanging publish while events
  keep arriving (applied within 1 second).

### 5.3 Compatibility checks

- `reset` with a pending `SessionStart` and a slow refresh running (Spec S6); `update --value` and `update --force` with
  pending events; `status` with pending events.
- Version handover (Spec S7), with an older worker (a lower record version, 6.3) running a slow publish: records of
  both versions arrive, older ones first. The older worker applies the older ones in order, leaves the newer record in
  place, releases the lock within about a second and starts no worker; the newer worker that the producer started
  applies the rest. No stop request file is written.
- Upgrade burst: 100 newer producers at once while an older worker runs. Every event is applied once, exactly one newer
  worker takes the lock, and the other started workers exit once it has written its version.
- A newer producer while a command of an older release holds the lock for 20 seconds: the worker it starts waits and
  applies the record after the command leaves. A producer while a command of its own release holds the lock starts no
  worker. A producer that checks after a holder took the lock and before it wrote its version starts a worker, which
  exits once the version is written.
- An older worker that takes the lock after a newer one left (started by an older producer): a newer record recorded
  then is applied by a newer worker within about a second.
- An older holder after a newer one (3.5, 3.12): a newer worker saves a state with an owed kind and entry fields the
  older release does not know, then an older command takes over. It applies its records, writes the newer key and
  fields back unchanged and starts no worker for them, and the worker of the next newer hook works them off; an older
  worker that holds the lock with only that work owed exits when idle. A `usageRefresh` entry for a source the older
  release does not know, as a later release that added a built-in source would owe it, is treated the same way: the
  older worker leaves it owed and does not count it, while an entry for a source it knows without a scanner (`grok`) is
  worked off and removed, refreshing every built-in on the first boundary of a day. A newer worker killed after its
  save and before deleting the applied files, then an older command: no record whose id is in `queueApplied` is
  applied again.
- Older commands, as section 7 describes them for the owner to confirm: an older command that holds the lock for more
  than 60 seconds on the injected clock leaves a newer record pending until the next hook; an older `reset` with a newer
  `SessionStart` pending finishes every session and publishes, and the newer worker applies the `SessionStart` after it
  (3.3, 3.7). These checks assert option (a) of section 7's older-release item; if the owner picks (b), they change
  with it.
- `uninstall --all` with a worker running and records pending, then a hook (Spec S10); `setup` afterwards records again.
- After a `UserPromptSubmit` with prompt text, no file next to the state file or under the presence home contains it
  (Spec S9).
- A state file written with `queueApplied` and `queueOwed` loads in the previous release; `worker --stop` leaves no
  record and writes the tombstone, after which a hook records nothing; `setup` then deletes the tombstone and stale
  records, and a normal `setup` without a tombstone leaves pending records alone.
- Downgrade between queue releases: after the newer release's `worker --stop`, a hook of the older release (a lower
  record version) records nothing and starts no worker; the older release's `setup` deletes the tombstone and the
  records left behind, and its hooks then record and apply again (3.8, 3.12).

### 5.4 Performance

- Hook cold start, median of 20 runs with a fresh `HOME`: the Q1 producer against the 143 ms baseline (1.1), with the
  baseline re-measured on the same machine; target at most 60 percent. The producer's run includes loading
  `@rivus/agent-kit/node` and `@rivus/agent-kit-collab/process-lock` (7.3 ms and 4.4 ms when each is imported alone,
  agent-kit#74; the process-lock entry also loads `@rivus/agent-kit/catalog`, which imports no zod in 0.14.0) and
  `node:sqlite` for the lock check (3.3).
- Event-to-state latency with a running worker and a slow publish in progress: under 1 second.
- 100 concurrent hooks: one worker, every event applied (Spec S3).

## 6. Execution plan

### 6.1 Preconditions

- Plan 0002 batches 3 and 4 merged (#97, #98: lazy command loading, the interpretation the producer reuses).
- Kit 0.15.0 (published 2026-10-14) or later, which Q1a pins and moves both kit packages to from the 0.13.0 that Plan
  0002 batch 4 pins, so Q1 waits on no kit release. 0.14.0 (published 2026-10-13), the first release with
  `isProcessLockHeld` (agent-kit#106, section 7), blocked the event loop on same-process lock contention, so Q1a's
  first cut kept a per-path turn queue in `src/process-lock.ts`; 0.15.0 takes turns of one lock inside a process in
  memory and makes `ProcessLock.holder` optional (a process that cannot read its own identity still takes a SQLite
  lock), so that queue is gone and the lock wrapper only converts the kit's held result to a thrown error.
  `acquireProcessLock` is already there, and since PerfectPan/agent-kit#78 (0.11.0) the `/node` and `/process-lock`
  entries bundle `zod/mini` and load no module from the `zod` package (kit adoption guide, "Choose the runtime
  boundary"), so the producer may load them.
- Section 7's stop-request question, which section 7 required to be settled before Q1a, is settled (2026-10-14; 3.3,
  3.6, 3.7). It was a design question, not an owner decision.
- Section 7's killed-command item, which the owner is to confirm, is confirmed before Q1 is released. It is not a
  precondition of Q1a or Q1b: an implementation follows the same exit order (3.6, 3.7) whichever way the owner decides.
- Section 7's older-command item, which the owner is to confirm, is confirmed before Q1 is released. It is not a
  precondition of Q1a or Q1b: option (a) is 3.3-3.7 as written, and option (b) adds to them through Plan 0002 batch
  5's shim, which lands after Q1, so it would come in before the release either way.
- The owner decided Plan 0002's collab release-age exclusion on 2026-10-13: Q1a, which adds `@rivus/agent-kit-collab`,
  adds it to `minimumReleaseAgeExclude` (`pnpm-workspace.yaml`, `CONTRIBUTING.md`). The owner chose option (c) of Plan
  0002's hook-path lock cost decision on 2026-10-13, so Q1 replaces batch 1, and decided the items that section 7 marks
  as decided.

### 6.2 Completion contract

| Spec scenario | Proved by                                           |
| ------------- | --------------------------------------------------- |
| S1, S3, S5    | Q1 latency, burst and idle-exit tests               |
| S2, S4        | Q1 order and crash tests                            |
| S6            | Q1 shutdown `reset` test                            |
| S7            | Q1a version-handover and Q1b upgrade-burst tests    |
| S8, S9, S10   | Q1 read-only directory, privacy and uninstall tests |

### 6.3 Execution order

#### Q1a: queue and worker, not yet wired (one PR)

- Files: new `src/queue/`, split so that no schema is reachable from the hook (3.2): `schema.ts` (the record schemas,
  the `v`-only schema, and the loose `queueApplied` and `queueOwed` schemas, 3.5) with the reader, the stop request and
  takeover (3.7, with the request's touches and age bound), the leaving order (3.6) and the tombstone writer, which the
  worker and the commands import, and `produce.ts` (record writer, epoch read, tombstone check and lock check, 3.3),
  which imports no schema module; `src/cli/commands/worker.ts`, registered in `src/cli/app.ts` and not listed in the
  help; `src/state.ts`, split the same way: the types and the
  session functions (`applyAgentEvent`, `isSessionBoundaryEvent`) stay there without a schema, and loading (with the queue-field schemas), saving and `withStateLock` on the kit's process lock move to a
  state-store module that the worker and the commands import; `src/log-retention.ts` (the log lock on the kit's process
  lock, with an append that waits until it holds the lock; the hardlink lock and its marker deleted), the shared lazy
  platform module (the lock changes and this module as Plan 0002 3.1 and its batch 1 describe them),
  `src/usage-events.ts`, split too: `usageEventFromPayload` and the `UsageEvent` type stay there for the producer, and
  the dsh append (it waits for the log lock and carries the record id) and the reader with its line schema (the optional
  `id`, repeated ids skipped) move to a module that the worker, the commands and `src/usage/scan-dsh.ts` import;
  `src/cli/hook-context.ts` and `src/sources.ts`, split as 3.2 states: the built-in table keeps only the resolvers (and
  the `scanEnv` names, which the scanners import from there, 3.2), and the built-in scanners and `billableSources` move
  to the new `src/usage/billable-sources.ts`, which `src/cli/usage-badge.ts` and `src/cli/commands/usage.ts` import;
  `src/cli/commands/hook.ts` (the direct application path moves behind a dynamic `import()`, so before Q1b replaces that
  path the hook's static graph reaches no state store, schema, dsh log or scanner module; it still reaches the kit lock
  through the log lock, Tests); `src/cli/usage-badge.ts` (an abort signal and a completion result), `package.json`
  (+`@rivus/agent-kit-collab` at the version of `@rivus/agent-kit`, both at 0.15.0 or later (6.1), `@rivus/agent-kit`
  moving up from 0.13.0, because collab's peer range spans one kit minor, as `^0.15.0` for collab 0.15.0; +`zod` at the
  kit's range, `^4.6.5`, shared with the kit so the lockfile resolves one copy), `pnpm-workspace.yaml` and
  `CONTRIBUTING.md` (`@rivus/agent-kit-collab` added to `minimumReleaseAgeExclude`, as the owner decided for Plan 0002's
  collab release-age exclusion), `docs/architecture.md` (the state and log locks on the kit's process lock, the source
  table's built-in resolvers without scanners, and `billableSources` with the built-in scanner table in
  `src/usage/billable-sources.ts`), tests.
- The worker runs from tests and from `agent-presence worker`; nothing writes records yet, so behavior does not change.
  The hook still runs the direct path, now loaded at run time; Q1a is not released on its own (4.1).
- Tests: 5.1's parsing checks, 5.2's worker checks, and 5.3's version checks that need no producer (the version
  handover, an older worker taking the lock after a newer one left, an older holder after a newer one with a takeover
  run by the test in place of the command), with the test writing the records and starting the workers. The record
  version that a worker or a takeover writes and compares is a parameter in tests, so one build runs an older and a
  newer release; the 250 ms rounds, the request touches and age check, the 60-second limit and the idle interval run
  on an injected clock.
  `test/hook-graph.test.ts` adds `@rivus/agent-kit-collab/process-lock` and
  `@rivus/agent-kit/node` to its allowlist next to `@rivus/agent-kit/harness/events`, because `src/sources.ts`,
  `src/cli/hook-output.ts` and `src/cli/io.ts` (its `writeLog` re-export, which the hook imports with `readStdinJson`)
  reach the log lock (as batch 1's lock change would have); `zod` stays off it, and the schema module, the state-store
  module, the dsh log module, `src/usage/billable-sources.ts` and the scanners (`src/usage/scan-*.ts`, `scan-dsh.ts`
  among them) join its forbidden modules.
- Exit: 5.2's worker checks and the version checks above pass; gates.

#### Q1b: producer, commands, uninstall (one PR, released with Q1a)

- Files: `src/cli/commands/hook.ts` (the producer, through a static import of `src/queue/produce.ts`; it no longer loads
  the direct path), `src/sources.ts` (diagnostics returned instead of written), `src/cli/hook-output.ts` (error record),
  `src/cli/commands/{status,reset,flush,update,uninstall}.ts` (takeover), `src/setup.ts`
  (tombstone removal), `docs/architecture.md` (the hook runtime: producer, queue, worker, takeover and tombstone), a
  changeset.
- Tests: every scenario in 6.2, and 5.3's producer and command checks: the upgrade burst, producers while a command
  holds the lock or before a holder writes its version, no stop request from a producer, the older-command checks
  (which follow option (a) of section 7's older-release item and change if the owner picks (b)), and the downgrade
  between queue releases. `test/hook-graph.test.ts`'s allowlist
  stays exactly `@rivus/agent-kit/harness/events`,
  `@rivus/agent-kit-collab/process-lock` and `@rivus/agent-kit/node`, now for the producer's lock check (3.3) and the
  platform it takes, and still for the log lock that `src/cli/io.ts` reaches; never `zod`. Its walk reaches
  `src/queue/produce.ts` and `src/cli/hook-context.ts` (through `src/sources.ts`) and none of the forbidden modules:
  the schema, state-store and dsh log modules, `src/usage/billable-sources.ts` and the scanners, `src/usage/scan-dsh.ts`
  among them. Hook cold start against the 143 ms baseline (5.4).
- Exit: every scenario in 6.2, the cold-start target, gates.

#### Q2: cleanup

- Remove the direct application path (the module the hook loaded at run time until Q1b) and the code only it used.

Relation to Plan 0002: Q1 is option (c) of Plan 0002's hook-path lock cost decision, which the owner chose on
2026-10-13: Q1 replaces batch 1, and Q1a carries batch 1's whole lock change: `withStateLock` and the log lock on the
kit lock, the shared platform module, their tests, and the deletion of the mkdir and hardlink locks (Plan 0002 3.1). Off
the hook path both locks keep batch 1's bounded waits, except the follow-up lane's dsh append, which waits until it
holds the log lock or a handover aborts the wait (3.5).

### 6.4 Validation ledger

| Batch | Command or evidence                                                                                                                                          | Expected result                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Q1a   | Crash, takeover, idle-race, version-handover and older-holder tests; a release runs the idle-race tests with `PRESENCE_RACE_RUNS=1000` before it ships (5.2) | No lost, doubled or stranded event or owed item   |
| Q1b   | Upgrade burst and producers during a command (5.3)                                                                                                           | One newer holder; every event applied once        |
| Q1b   | Event table through producer and worker                                                                                                                      | Same state as the direct path for all 67 cases    |
| Q1b   | Hook cold start against the 143 ms pre-split baseline (1.1), re-measured on the same machine (5.4)                                                           | At most 60 percent                                |
| Q1b   | `reset` during a slow refresh; uninstall                                                                                                                     | No running session within the bound; nothing left |
| all   | Repository gates                                                                                                                                             | Pass                                              |

### 6.5 Work split and schedule

| Batch | Owner       | Depends on                                | When        |
| ----- | ----------- | ----------------------------------------- | ----------- |
| Q1a   | unconfirmed | Kit 0.15.0 (released, 6.1)                | unconfirmed |
| Q1b   | unconfirmed | Q1a                                       | unconfirmed |
| Q2    | unconfirmed | Q1b released with Plan 0002 batch 5 (4.1) | unconfirmed |

## 7. Risks, open questions, and follow-up

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Type                                                                                         | Next step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idle interval                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Decided (owner, 2026-10-13)                                                                  | 5 minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| One configuration per state file; credentials from the environment the worker was started with, which is always that of a hook or of a command that took over (a worker that stops for a request passes its own on to the worker it starts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Decided (owner, 2026-10-13)                                                                  | As 3.9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The whole feature ships in one release, with no mode switch; a downgrade runs `agent-presence worker --stop` first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Decided (owner, 2026-10-13)                                                                  | As 4.1 and 4.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Node-free shell producer as the stable hook shim: Plan 0002's hook-command decision chose a stable shim file (owner, 2026-10-13); whether that shim runs without Node is this item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Owner                                                                                        | A few milliseconds per hook, but `sh` cannot parse JSON, so it would record the raw payload, against S9; recommend not now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A producer's stop request for an older-version worker (3.3) carries the producer's own pid, but under 3.7 a request whose pid is no longer alive is stale and ignored, and the producer exits within milliseconds, so the old worker would ignore it; S7 relies on the new worker writing its own request (3.7). Same-version workers also yield the lock to each other's requests, so several new workers started during an upgrade burst may pass the lock back and forth. A producer that finds the lock held by a command, or by a worker that has not yet written `<state>.worker.v`, reads an earlier worker's version or `0` (3.3) and may start a worker and write a request that the holder's version did not call for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Resolved (design, 2026-10-14)                                                                | None: only a command writes a stop request, and it stays alive while it waits; producers and workers write none (3.3, 3.7). A worker stops for a live request or for a record with a higher `v`, never for another worker; an older worker that lists a newer record applies the records before it and leaves, starting no worker, and the worker that record's producer started takes the lock (3.7). Every holder, worker or command, writes `<state>.worker.v` after it takes the lock and deletes it before it releases it, so a producer reads the holder's version or `0`. A started worker repeats the producer's check every 250 ms for up to 60 seconds, makes no try while a request is live, and exits once a holder of its release or a newer one has written its version, so a burst leaves one worker and the lock is not passed back and forth (3.3, 3.6). An idle worker makes no retake while a request is live (3.6), and a request stops counting 6 seconds after its command last touched it (every 2 seconds while it waits), so a command killed while it waits cannot keep workers from the lock through a reused pid, and a request deleted as stale after a sleep or a clock change comes back at the next touch (3.7). Checks in 5.2 and 5.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A process of an older queue release that takes the lock after a newer one (3.12) loads and saves `queueApplied` and `queueOwed`. With strict schemas it would drop owed work that the newer release added, and if a newer release changed their format it would load `queueApplied` as absent and apply again the records a newer worker saved just before it crashed. It would also remove, as done, owed work it cannot do, such as the refresh of a built-in source that a newer release added (the older refresh returns at once for a source it has no scanner for, `src/cli/usage-badge.ts:79-81`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Resolved (design, 2026-10-14)                                                                | None: Q1 fixes both formats. Later releases only add a `queueOwed` key, or a field an older release can ignore on an entry or on an object inside one (`usage`, `scanEnv`); a field an older release cannot ignore, or a scanner for a source an earlier release has without one, goes into a new kind of owed work; they raise `v` when they add a kind of owed work or a built-in source. Every release parses both fields and the objects inside their entries with `looseObject`, writes back what it does not know, changes known entries in place, and works off only the owed work it can do: the kinds it knows, except a refresh for a source not in its merged source table, which stays owed (3.5, 3.12). Rejected: a version stamp in the state that makes an older holder skip its save and hand over, since an older command, such as a deferred `flush` or a `reset` started before the upgrade, could then do nothing, and a downgrade would have to clear the stamp. Checks in 5.1 and 5.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Processes of an older release at the lock after an upgrade between queue releases (3.12: a command running since before the upgrade, a deferred `flush` the older worker scheduled, a worker one of them starts when it leaves, a command the user runs from another installed release) cannot apply records of a newer `v`. Two exceptions to the Spec follow. (1) Order: an older command stops applying at the first newer record and runs its own code without it, and a newer worker applies it afterwards (3.7); after an older `reset`, a newer `SessionStart` that was pending at its takeover leaves that session running, against S6 and the rule that commands apply every event recorded before them. (2) Waiting: newer records wait for a later hook or command when older commands hold the lock longer than a started worker's 60 seconds, one alone or several in a row, or when a holder crashes and an older process takes the lock next while a newer record is checked in the milliseconds before that process writes its version (3.3), against S7's timing. Owed work that only the newer release can do (a new kind, or a refresh for a source the older release does not know, 3.5) waits for a newer worker whenever an older process holds the lock, and an older worker exits when idle with it pending (3.6), against the rule that the worker exits only when no follow-up work is pending; a later hook or command gets it done | Owner (to confirm)                                                                           | Options: (a) accept both for Q1, waiting follow-up work included; (b) close them through the stable shim (Plan 0002 3.5). Recommend (a): both need a release that raises `v` (an incompatible record change, a new kind of owed work or a new built-in source, 3.2) and an older process at the lock after it, while the hooks and, through the stable shim, the shutdown watcher run the installed release (3.12, inferred); the next hook or command applies what waits, as after the accepted worker crash. Option (b), evaluated and not adopted: a leaving holder starts its worker through the shim, which runs the installed release, instead of its own release. That closes the record waits in (2) except a crash with an older worker next, and needs no new guard against a spawn loop as long as a worker that leaves for a newer record still starts none (3.6): in a downgrade without `worker --stop`, the shim worker a command starts leaves after one listing. It closes the follow-up wait in (2) only when the leaving holder starts a worker anyway, since a holder starts none for owed work it cannot do (3.6); starting one for that work alone would start a worker every idle interval after a downgrade without `worker --stop`, where the shim runs the older release (inferred). It does not fix (1): the newer `SessionStart` is only applied sooner after the reset. Fixing (1) also needs an older command that finds a newer record at its takeover to release the lock and run itself again through the shim, passing on its output and exit code, with a marker that keeps that run from doing the same. The shim path and the marker would join the names every queue release keeps (3.12), the shim lands with Plan 0002 batch 5 after Q1, and a run through the shim that cannot start leaves the shutdown `reset` undone unless the older command then runs its own. Confirm before Q1 is released; not a Q1a precondition (6.1) |
| A worker stuck in an iteration blocks takeovers and new workers until it is killed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Risk                                                                                         | Abort signals and timeouts on external calls; automatic takeover after a stuck period as a follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A configured source whose id a later release turns into a built-in source with a scanner (3.5): an older holder knows that id as a source without a scanner, so it works off the later release's owed refresh for it, the refresh returns early, and the entry is deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Risk                                                                                         | Accept (inferred): it needs a configured id equal to a later built-in id and an older holder at the lock in the same window; the refresh is lost only until that source's next boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Kit 0.13.0 offered no way to ask whether a process lock is held without taking it (3.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Resolved by kit 0.14.0 ([agent-kit#106](https://github.com/PerfectPan/agent-kit/issues/106)) | None: kit 0.14.0 (published 2026-10-13) ships `isProcessLockHeld(platform: ProcessLockPlatform, path: string, options?: { signal?: AbortSignal }): Promise<boolean>` in `@rivus/agent-kit-collab/process-lock` with the properties asked for here (kit Spec S68): it never takes or keeps the lock and never writes `<path>.holder`; with SQLite it makes one attempt (a file stat, a read-only open with `busy_timeout = 0`, one statement under a shared lock), without settle retries, and reads no process identity; checks running at once do not see each other as holders; a missing lock file reads as free and is not created. An acquisition's first attempt still gets a free lock while checks run; the kit's one caveat is that the later retries of a waiting acquisition can find the lock busy while a check reads it and get it one backoff later (3.3). Q1a pins 0.14.0 or later                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A crash right after a producer found the worker lock held leaves that record pending until a later hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Accepted risk, decided (owner, 2026-10-13)                                                   | As the Spec states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A command that holds the worker lock and is killed, for example by a signal, skips its exit order (3.3, 3.7), so every record a producer renamed after the command's takeover listing (while it makes its own change and publishes: seconds) stays pending; the accepted worker-crash risk above covers only the moment after a producer's check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Owner (to confirm)                                                                           | Consequence: those records wait for the next hook or command, which applies them. Recommend accepting: a command holds the lock for seconds, and the next hook or command applies what it left. Confirm before Q1 is released; not a Q1a precondition, since an implementation follows the same exit order (3.6, 3.7) either way (6.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Upgrading from a release before the queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Decided (owner, 2026-10-13)                                                                  | Uninstall the previous release with its own `agent-presence uninstall` first; no handling of a previous release running alongside (3.12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A flush the previous release scheduled before its uninstall still runs when due, and retries while the provider rate-limits it; its saves drop the queue fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Decided (owner, 2026-10-13)                                                                  | Not handled (3.12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
