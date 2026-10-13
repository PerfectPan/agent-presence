# Hook Event Queue

- Status: in review
- Owner: unconfirmed
- Reviewer: PerfectPan
- Last updated: 2026-10-13
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
- Slow work never delays applying events, and anything that needs the applier's place takes it over through one
  mechanism: a stop request.

### 2.2 Boundaries and responsibilities

| Part                      | Owns                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Producer (`hook` command) | Interpreting the payload in process (Plan 0002 rules), writing one record, starting a worker if needed                |
| Queue (`<state>.queue/`)  | Durable records; nothing else                                                                                         |
| Worker (`worker` command) | Applying records (apply lane) and owed follow-up work and publishing (follow-up lane)                                 |
| Commands                  | `status`, `reset`, `flush`, `update`, `worker --stop`, `uninstall --all`: take over, then act                         |
| `@rivus/agent-kit-collab` | `acquireProcessLock` for the applier, `withStateLock` and the log lock; the producer's check of the worker lock (3.3) |

### 2.3 Main path

1. `hook` resolves the source, session, project and internal event name in process, writes a record (temporary file,
   then `rename`), starts a worker if none holds the worker lock (3.3), prints its output and exits.
2. The worker's apply lane lists the queue every 250 ms, applies the new records under the state lock, saves the state
   together with their ids and the follow-up work they owe, then deletes their files.
3. The follow-up lane works off owed dsh usage appends, per-source usage refreshes and the owed rendered sync, one at a
   time.
4. A command that changes state takes over from the worker (3.7), applies what is pending, and runs today's code.
5. After the idle interval with nothing pending, the worker exits (3.6).

### 2.4 Design decisions

| Decision          | Choice                                                                                                                                                         | Rejected                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport         | One file per event, `rename` into the queue directory                                                                                                          | Append-only file (rotation races); socket (loses events when nothing listens)                                                                                                           |
| Consumer lifetime | Started on demand, exits when idle                                                                                                                             | System service (install, upgrade and uninstall surface on two platforms, always resident)                                                                                               |
| Exactly once      | Applied record ids, owed dsh appends and owed per-source refreshes saved with the state                                                                        | Idempotent replay (fallback finish and reopen are not idempotent)                                                                                                                       |
| Publishing        | Today's rendered sync, owed as one `renderedSync` flag that the sync's own locked save clears                                                                  | A publish debt with its outcome (today's sync claims the interval before publishing, so a replay returns "debounced")                                                                   |
| Slow work         | A separate follow-up lane                                                                                                                                      | One loop (a slow publish delays every event)                                                                                                                                            |
| Taking over       | A stop request; the holder stops within an iteration and leaves owed work in the state                                                                         | Command records with results and deadlines (receipts and snapshots across lanes)                                                                                                        |
| Single applier    | `acquireProcessLock` on `<state>.worker.lock.db`, never deleted                                                                                                | PID file alone (stale after a crash); deleting the lock file (breaks mutual exclusion)                                                                                                  |
| Liveness check    | A check whether a process holds `<state>.worker.lock.db`, without taking it (a kit gap, agent-kit#106, 3.3); the holder's record version in `<state>.worker.v` | `acquireProcessLock` with `wait: false` (takes a free lock on the hook path, about 125 ms against a held one); `<state>.worker.json` parsed by the producer (a schema on the hook path) |
| Record content    | Presence's normalized event                                                                                                                                    | Raw payload (prompt text and tool arguments on disk, Spec S9)                                                                                                                           |
| Order             | `rename` is the recording point; a batch sorts by recorded time                                                                                                | A monotonic clock across processes (needs a boot identity the producer cannot get cheaply)                                                                                              |
| Uninstall         | A `<state>.disabled` tombstone that producers and workers honor until `setup`                                                                                  | Waiting for the lock only (late hooks recreate the state)                                                                                                                               |
| Rollout           | The whole feature in one release, no mode switch                                                                                                               | A `direct`/`queue` switch (switching back can reorder pending events)                                                                                                                   |

## 3. Detailed design

### 3.1 Entry points

- `agent-presence hook ...`: every installed form (`--source/--event`, `--agent`) becomes the producer. Interpretation is
  Plan 0002 batch 4's; only the application moves to the worker.
- `agent-presence worker`: a new command, not shown in help, started detached by producers and commands with the pattern
  `deferred-update.ts:8-24` already uses. `agent-presence worker --stop` takes over, applies what is pending and exits.
- `status`, `reset`, `flush`, `update`, `uninstall --all`: 3.7 and 3.8.

### 3.2 Records

- Location: `<state file>.queue/` (mode 0700), so every state file has its own queue and worker. File name
  `<recordedAt, 13 digits>-<pid>-<4 random hex>.json` (mode 0600), written as `.tmp-<name>` and renamed. The worker
  removes `.tmp-*` files older than one hour.
- Variants, all with `v` (record version), `id` (the file name without extension), `recordedAt` (wall-clock ms) and
  `epoch` (the number the producer read from `<state>.epoch` before its tombstone check, 3.3 and 3.8; `0` while that file
  does not exist, as on a first install before any `setup` removed a tombstone):

  | `kind`  | Fields                                                                                                                                        |
  | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
  | `event` | `source`, `event` (presence's internal name), `sessionId`, `project`, `subagent` (`id`, `type`), `usage` (dsh only), `scanEnv`, `payloadKeys` |
  | `skip`  | `code` (`missing-session-id`, `no-presence-source`, `ignored-event`), `source` or `agent`, `nativeEvent`, `payloadKeys`                       |
  | `error` | `code` (for example `handler-refused`, `resolver-failed`, `hook-load-failed`), `source` if known, a message without payload values            |
  - `usage` holds the normalized dsh usage event: `model` (a model name, needed for pricing, `src/usage/pricing.ts:122-128`)
    and the token and cost numbers (`src/usage-events.ts:63-71`); nothing else from the payload.
  - `scanEnv` holds the environment values that locate the source's transcripts (for example `CLAUDE_CONFIG_DIR`); Q1
    inventories them from the scanners and lists their names next to the resolvers in `src/cli/hook-context.ts`, so the
    producer copies them without loading a scanner (below). The scanners import the same list from there and read their
    variables only through it, so a variable a scanner reads is always one the producer copies. It is set on boundary
    events only and never carries credentials.
  - `payloadKeys` holds key names, for the diagnostic log.

- `v` increases on an incompatible change. A worker never applies a record with a higher `v` (3.7).
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
  comes from the kit's process lock (3.3). `usageEventFromPayload`, which the producer uses for dsh usage, stays in a
  module without a schema.
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
4. Checks whether a process holds `<state>.worker.lock.db`, without taking the lock. If none does, it starts a worker.
   If one does, it reads `<state>.worker.v` as decimal text, which counts as `0`, like the epoch, when the file is
   missing or its text is not a non-negative integer; if that version is lower than its own record version, it starts a
   worker and writes a stop request (3.7).

- The worker writes its record version to `<state>.worker.v` (decimal text, temporary file and `rename`) once it holds
  the lock. Only a worker writes it, so while a command holds the lock, or a worker that has not written it yet, the
  producer reads an earlier worker's version, or `0` when no worker has written it since the first install or
  `uninstall --all` (3.8). If that is lower than the producer's record version, the producer starts a worker and writes
  a stop request that the holder's own version did not call for. A command does not yield to stop requests (3.7), so
  that worker waits for the lock like any contender. How this interacts with the upgrade takeover is part of section
  7's open question.
- A worker crash releases the lock at once (the kernel drops the SQLite lock), so the next producer finds it free and
  starts a worker. A crash right after a producer found the lock held leaves that producer's record pending until a
  later hook or command (Spec). A command that holds the lock and is killed, for example by a signal, releases it the
  same way but skips its exit order (3.7), so a record a producer renamed while the command held the lock stays pending
  too; this falls under section 7's accepted crash risk.
- Step 4 needs a check that kit 0.13.0 does not offer: `@rivus/agent-kit-collab/process-lock` exports only
  `acquireProcessLock` and its types. `acquireProcessLock` with `wait: false` cannot stand in for it. When the lock is
  free, it takes it and writes `<path>.holder`, which puts a lock back on the hook path. When the lock is held, it
  returns only after its first attempt's settle retries, five tries with a 10 ms SQLite busy timeout and four pauses of
  5-25 ms: about 125 ms (median of 20, 99-143 ms) in a `node:sqlite` reproduction of that attempt on macOS, more than
  the whole 85 ms target. And every call reads the process identity first (`sysctl` and `ps` on macOS, about 7 ms,
  1.1). Section 7 states the interface Q1 needs from the kit; Q1 waits for a kit release that provides it.

### 3.4 Order

- The recording point is the `rename`. A command hook exits only after its `rename`, and the agent starts its next hook
  for that session after the previous one exits, so sequential events have increasing `recordedAt` unless the system
  clock steps backwards, and the later one is never applied in an earlier batch.
- Each batch is applied sorted by `recordedAt`, then by file name. Events recorded concurrently (opencode and Pi bridges
  that do not wait, parallel tool calls) have no defined order, as today.

### 3.5 Applying exactly once

The state file gains two optional fields, parsed with a zod/mini schema when the state is loaded, in the state-store
module that the hook graph does not reach (3.2, 6.3); an invalid value loads as absent, never as a failed load. Older
releases drop them:

- `queueApplied`: ids of applied records whose files may still exist.
- `queueOwed`: `dshUsage` (usage events still to append, each with its record id), `usageRefresh` (one entry per source
  and `scanEnv`, with the latest boundary time and a generation number that increases whenever a newer boundary updates
  the entry), and `renderedSync` (set when applied events changed what the slot renders and no sync has run since).

Apply lane, every 250 ms, unless a stop request it did not write exists (3.7):

1. List the queue; delete files whose ids are in `queueApplied`; read the rest, stopping at a record with a higher `v`.
2. Under `withStateLock`: load the state; apply each record in order with its recorded time (`applyAgentEvent` and the
   session expiry the hook applies today; `skip` and `error` records change nothing); add the ids to `queueApplied`; add
   owed work: a dsh append per usage-bearing event, for each boundary event the refresh entry of its source and `scanEnv`
   (created or updated, generation increased), and `renderedSync` when an `event` record was applied; save once.
3. Delete the applied files; at the next save, drop from `queueApplied` the ids whose files no longer exist.

Follow-up lane, one item at a time, concurrently with the apply lane, checking for a stop request between items:

- dsh usage append: through the retained-log append, but waiting until it holds the log lock instead of skipping (the
  lane is off the hook path), with the record id in the entry. The wait takes the lane's abort signal
  (`acquireProcessLock`'s `signal`), so a stuck log-lock holder cannot keep the worker from handing over; an aborted
  append stays owed. The dsh usage scanner reads the optional `id` through its zod/mini line schema, which replaces the
  hand-written `asUsageEvent` (`src/usage-events.ts:75-92`) in a module the hook graph does not reach (3.2), and skips a
  repeated id. The item leaves `queueOwed` only after the append wrote.
- Usage refresh: through the existing refresh for that source, with its `scanEnv` and boundary time so the day rule
  (`usage-badge.ts:71-79`) holds. The refresh gains an abort signal and returns whether it completed. Afterwards, under
  the state lock, the entry is removed only if its generation is still the one the refresh started with; a boundary that
  arrived during the scan keeps it owed.
- Rendered sync: when `renderedSync` is set, today's `syncRenderedSlotWithDeferredFlush` runs once with the worker's
  clock. It publishes or schedules the deferred flush exactly as the hook does today. `renderedSync` is cleared in the
  locked save that records the publish's success, in the save that schedules the deferred flush, or when the sync finds
  nothing to publish; a rollback after a failed or aborted publish keeps it. So if the worker dies or hands over before
  the publish finished, the next applier runs the sync again; when the interrupted publish already claimed the interval,
  that sync schedules the forced publish one debounce interval later.
- A completed usage refresh sets `renderedSync` again, because it changes what the slot renders.

A stop request that is not the holder's own aborts the item in progress through its abort signal (the dsh append's wait
for the log lock, the refresh's scans, the publish's request), so the holder stops within about a second; an aborted
item stays owed. The holder releases the lock only after the apply lane's current batch has saved or been dropped and
the follow-up item has ended, with any rollback it triggers saved, so no write of the old holder lands after the new
holder starts.

### 3.6 Idle exit

After the idle interval with an empty queue and an empty `queueOwed`:

1. Release the lock.
2. List the queue once more. If a record is there, take the lock again with `wait: false`: if that succeeds, rewrite
   `<state>.worker.v` and continue as the worker; if another process holds the lock by now, exit.
3. Otherwise exit. Nothing slow runs after step 1, and nothing is written unless step 2 takes the lock again.

A producer renames its record, then checks the lock (3.3). A record renamed before step 2 is seen in step 2; one renamed
after it is followed by a check that runs after step 1, which finds the lock free, so the producer starts a worker that
waits up to 5 seconds for the lock, or finds it held by a process that took it after step 1: a worker lists the queue
after taking it, and a command lists it once more when it leaves, after releasing the lock (next paragraph and 3.7's
exit order), which also covers a record renamed after the command's own takeover listing. A scheduled publish is
already held by the deferred flush the sync spawned.

A command that holds the lock leaves in the same order (3.7): it notes whether owed work remains, releases the lock,
lists the queue once more and starts a worker if owed work remained or a record is there. The argument is the same: a
producer that renamed its record while the command held the lock, and so started no worker, renamed it before that
listing, which sees it. A record renamed after the listing is followed by a check that runs after the release, which
finds the lock free or held by a later holder that applies it.

### 3.7 Taking over

- A process that needs the applier's place writes its own request file `<state>.worker.stop.<token>` holding its pid,
  and waits for the lock: a command up to 10 seconds, a newer-version worker up to 60 seconds. A request whose pid is no
  longer alive is stale: any holder deletes it and ignores it. A requester deletes its own file when it gets the lock or
  gives up.
- A worker that holds the lock and finds a live request that is not its own stops at its next apply-lane iteration or
  between follow-up items: it aborts the item in progress and releases the lock. A worker that wins the lock from
  another contender does the same, so the lock passes on until the requester holds it. A command that holds the lock
  does not yield to requests: it keeps the lock for its own bounded run and releases it when it exits.
- The requester, holding the lock, deletes its request, then:
  - a newer-version worker continues as the worker, applying the records the old one left;
  - `status`, `flush` and `update` apply the pending records and append the owed dsh usage (apply-lane steps 1-3 and the
    dsh items), then run today's command code; `flush` and `update` clear `renderedSync` through their own sync;
  - `reset` applies the pending records only, finishes every session and publishes, clearing `renderedSync`; its time is
    bounded by the takeover wait, one in-memory pass with one save over the pending records, the credential read and
    publish timeouts, and exiting (it waits for no background work it started) (Spec S6);
  - `worker --stop`: 3.8.
- Every lock holder that exits follows 3.6's order, commands included. Whether a command succeeded or failed, it notes
  while it still holds the lock whether owed work remains, then releases the lock, lists the queue once more, and starts
  a background worker if owed work remained or a record is there. A producer that renamed its record while the command
  held the lock started no worker (3.3); this listing is what gets that record applied (3.6). This covers `status`,
  `reset`, `flush`, `update` and `setup` after it removed a tombstone (3.8); `uninstall --all` and `worker --stop` leave
  the tombstone in place and start no worker.
- The shutdown watcher runs `reset --force --silent` and waits for it without a deadline, so the bound above is the
  shutdown delay. `--silent` keeps its meaning.
- A command that cannot take the lock within its wait fails as a command failure does today.

### 3.8 Uninstall and setup

- `<state>.epoch` holds a number that producers copy into each record; workers and commands apply only records whose
  epoch matches the file. `setup`, when it removes a tombstone, increases it. Producers and appliers read it alike, as
  decimal text without a schema (3.2): a missing file, or text that is not a non-negative integer, counts as `0`, so a
  first install records and applies epoch `0`, and the first increase writes `1`.
- `<state>.disabled` is a tombstone. Producers check it after reading the epoch and before recording (3.3), workers
  before starting and at every iteration, and `status`, `reset`, `flush` and `update` right after taking over. While it
  exists, producers record nothing, workers exit, and those commands change nothing.
- `uninstall --all` writes the tombstone, takes over, deletes the queue directory, the stop-request files and
  `<state>.worker.v`, then the state as today. It keeps `<state>.worker.lock.db` and `<state>.epoch`. The lock's
  `<state>.worker.lock.db.holder` is the kit's: written when `uninstall --all` takes the lock and deleted by the kit's
  `release()` when it releases it, so none is left after a normal exit. A producer that passed its tombstone check just
  before can still write one record afterwards; nothing applies it while the tombstone exists, and after `setup` its
  old epoch makes every applier delete it unapplied.
- `worker --stop` takes over, applies the pending records, works off the owed items, writes the tombstone and exits. From
  then on new-release hooks record nothing and no new-release worker starts, so the previous release can be installed; it
  ignores the tombstone and the queue.
- `setup` of the new release, when it finds the tombstone, takes over, deletes every record in the queue (each was
  recorded before or around an uninstall or a downgrade) and then the tombstone. Without a tombstone it leaves the queue
  alone.
- `uninstall` without `--all` changes none of these; the worker exits when idle.

### 3.9 Configuration and credentials

- One state file, one configuration. The worker reads the configuration file before each batch and uses the environment
  of the process that started it (a hook or a command that took over, 3.7) for credentials (`src/secret.ts:41-57`) and
  provider overrides. A hook or command whose environment differs (another credential, another state or config path)
  for the same state file is not supported; section 7.
- Transcript roots travel with boundary events in `scanEnv`.
- Records never carry credentials.

### 3.10 Failures

| Failure                  | Behavior                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Record cannot be written | The hook prints its output and exits 0; the event is lost (Spec S8)                                                  |
| Worker cannot be started | Records wait; the next producer tries again                                                                          |
| Worker killed            | The kernel releases the SQLite lock; `queueApplied` and `queueOwed` finish the work (Spec S4)                        |
| Worker stuck             | It keeps the lock, so producers start no other worker; takeovers time out and commands fail; records wait; section 7 |
| Bad record               | Moved to `<state>.queue/failed/` (kept 7 days), logged, skipped                                                      |
| Large backlog            | Nothing is dropped; above 10,000 records the worker logs a warning                                                   |
| External call hangs      | Scans and the publish take an abort signal and a timeout; the apply lane continues                                   |

### 3.11 Logs

The producer writes no log line. Source resolution returns its diagnostics instead of writing them, and the producer
records them as `error` records; the hook-module load fallback records an `error` record, and if recording fails too it
only prints the output. The worker writes the diagnostic line for each event (payload key names), the line the hook
writes today for each `skip` and `error` record, and `worker.start`, `worker.exit` with its reason, batch sizes, failed
records and backlog warnings.

### 3.12 Compatibility and migration

- Upgrading from a release before the queue: uninstall that release with its own `agent-presence uninstall`, which
  removes the hooks it installed at whatever paths it used, then install the new release and run `setup`. The new release
  does not handle a previous release running alongside it.
- A deferred flush that the previous release scheduled before its uninstall (`deferred-update.ts:9-24`) is a detached
  timer the uninstall does not stop. It still runs that release's `flush` when due, and its retries while the provider
  rate-limits it (`deferred-update.ts:78-87`); it ignores the queue and the tombstone, and each of its saves drops
  `queueApplied` and `queueOwed`, so at most the records of one batch can be applied twice and the owed items of that
  moment are lost. Decided (owner, 2026-10-13): this is not handled.
- Upgrades between releases that both have the queue use the record version and the takeover (3.3, 3.7).
- Downgrade: `agent-presence worker --stop` with the new release, then install the previous release, which ignores the
  queue and the worker files.

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

`agent-presence worker --stop`, then downgrade to the previous release (3.12).

## 5. Verification

### 5.1 Functional checks

- Record codec, writer and sorter; interpretation to record, one case per row of Plan 0002's event table.
- Parsing: every malformed record (each `kind` with a missing or mistyped field, unknown `kind`, invalid JSON) is
  rejected as a bad record, and a record with a higher `v` is left in place; a state file with a malformed `queueOwed`
  (or `queueApplied`) loads with that field absent.
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
- A stop request written by one command while a producer-started worker wins the lock: that worker yields, and the
  command gets the lock.
- A command that fails after taking over starts a background worker when records or owed work remain.
- Idle-exit race: producers recording while a worker exits, and while a command that took over (`status`, `flush`) holds
  the lock and exits, 1,000 iterations each with random delays: no record stays.
- A worker killed while a producer writes: the next hook starts a worker.
- A takeover while a slow refresh runs: the holder stops within about a second, and the refresh stays owed.
- Two workers started together; a corrupt record; a read-only queue directory (Spec S8); a hanging publish while events
  keep arriving (applied within 1 second).

### 5.3 Compatibility checks

- `reset` with a pending `SessionStart` and a slow refresh running (Spec S6); `update --value` and `update --force` with
  pending events; `status` with pending events.
- A newer-version record with an older worker running (Spec S7).
- `uninstall --all` with a worker running and records pending, then a hook (Spec S10); `setup` afterwards records again.
- After a `UserPromptSubmit` with prompt text, no file next to the state file or under the presence home contains it
  (Spec S9).
- A state file written with `queueApplied` and `queueOwed` loads in the previous release; `worker --stop` leaves no
  record and writes the tombstone, after which a hook records nothing; `setup` then deletes the tombstone and stale
  records, and a normal `setup` without a tombstone leaves pending records alone.

### 5.4 Performance

- Hook cold start, median of 20 runs with a fresh `HOME`: the Q1 producer against the 143 ms baseline (1.1), with the
  baseline re-measured on the same machine; target at most 60 percent. The producer's run includes loading
  `@rivus/agent-kit/node` and `@rivus/agent-kit-collab/process-lock` (7.3 ms and 4.4 ms when each is imported alone,
  agent-kit#74; the process-lock entry also loads `@rivus/agent-kit/catalog`, which imports no zod in 0.13.0) and
  `node:sqlite` for the lock check (3.3).
- Event-to-state latency with a running worker and a slow publish in progress: under 1 second.
- 100 concurrent hooks: one worker, every event applied (Spec S3).

## 6. Execution plan

### 6.1 Preconditions

- Plan 0002 batches 3 and 4 merged (#97, #98: lazy command loading, the interpretation the producer reuses).
- A kit release with the lock check that section 7 asks for, which kit 0.13.0 (pinned by Plan 0002 batch 4) lacks; Q1a
  moves both kit packages to it, and Q1 waits for it. `acquireProcessLock` is already there, and since
  PerfectPan/agent-kit#78 (0.11.0) the `/node` and `/process-lock` entries bundle `zod/mini` and load no module from the
  `zod` package (kit adoption guide, "Choose the runtime boundary"), so the producer may load them.
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
| S7            | Q1 upgrade test                                     |
| S8, S9, S10   | Q1 read-only directory, privacy and uninstall tests |

### 6.3 Execution order

#### Q1a: queue and worker, not yet wired (one PR)

- Files: new `src/queue/`, split so that no schema is reachable from the hook (3.2): `schema.ts` (the record schemas,
  the `v`-only schema, and the `queueApplied` and `queueOwed` schemas) with the reader, the stop request and the
  tombstone writer, which the worker and the commands import, and `produce.ts` (record writer, epoch read, tombstone
  check and lock check, 3.3), which imports no schema module; `src/cli/commands/worker.ts`; `src/state.ts`, split the
  same way: the types and the session functions (`applyAgentEvent`, `isSessionBoundaryEvent`) stay there without a
  schema, and loading (with the queue-field schemas), saving and `withStateLock` on the kit's process lock move to a
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
  through the log lock, Tests);
  `src/cli/usage-badge.ts` (an abort signal and a completion result), `package.json` (+`@rivus/agent-kit-collab` at the
  version of `@rivus/agent-kit`, both at the kit release with the lock check (6.1), because collab's peer range spans
  one kit minor, as `^0.13.0` for collab 0.13.0; +`zod` at the kit's range, `^4.6.5`, shared with the kit so the
  lockfile resolves one copy), `pnpm-workspace.yaml` and `CONTRIBUTING.md` (`@rivus/agent-kit-collab` added to
  `minimumReleaseAgeExclude`, as the owner decided for Plan 0002's collab release-age exclusion), `docs/architecture.md`
  (the state and log locks on the kit's process lock, the source table's built-in resolvers without scanners, and
  `billableSources` with the built-in scanner table in `src/usage/billable-sources.ts`), tests.
- The worker runs from tests and from `agent-presence worker`; nothing writes records yet, so behavior does not change.
  The hook still runs the direct path, now loaded at run time; Q1a is not released on its own (4.1).
- Tests: 5.2's worker checks. `test/hook-graph.test.ts` adds `@rivus/agent-kit-collab/process-lock` and
  `@rivus/agent-kit/node` to its allowlist next to `@rivus/agent-kit/harness/events`, because `src/sources.ts`,
  `src/cli/hook-output.ts` and `src/cli/io.ts` (its `writeLog` re-export, which the hook imports with `readStdinJson`)
  reach the log lock (as batch 1's lock change would have); `zod` stays off it, and the schema module, the state-store
  module, the dsh log module, `src/usage/billable-sources.ts` and the scanners (`src/usage/scan-*.ts`, `scan-dsh.ts`
  among them) join its forbidden modules.
- Exit: 5.2's worker checks pass; gates.

#### Q1b: producer, commands, uninstall (one PR, released with Q1a)

- Files: `src/cli/commands/hook.ts` (the producer, through a static import of `src/queue/produce.ts`; it no longer loads
  the direct path), `src/sources.ts` (diagnostics returned instead of written), `src/cli/hook-output.ts` (error record),
  `src/cli/app.ts` (`worker`), `src/cli/commands/{status,reset,flush,update,uninstall}.ts` (takeover), `src/setup.ts`
  (tombstone removal), `docs/architecture.md` (the hook runtime: producer, queue, worker, takeover and tombstone), a
  changeset.
- Tests: every scenario in 6.2. `test/hook-graph.test.ts`'s allowlist stays exactly `@rivus/agent-kit/harness/events`,
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

| Batch | Command or evidence                                                                                | Expected result                                   |
| ----- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Q1a   | Crash, takeover and idle-race tests                                                                | No lost, doubled or stranded event or owed item   |
| Q1b   | Event table through producer and worker                                                            | Same state as the direct path for all 67 cases    |
| Q1b   | Hook cold start against the 143 ms pre-split baseline (1.1), re-measured on the same machine (5.4) | At most 60 percent                                |
| Q1b   | `reset` during a slow refresh; uninstall                                                           | No running session within the bound; nothing left |
| all   | Repository gates                                                                                   | Pass                                              |

### 6.5 Work split and schedule

| Batch | Owner       | Depends on                                | When        |
| ----- | ----------- | ----------------------------------------- | ----------- |
| Q1a   | unconfirmed | The kit release in 6.1                    | unconfirmed |
| Q1b   | unconfirmed | Q1a                                       | unconfirmed |
| Q2    | unconfirmed | Q1b released with Plan 0002 batch 5 (4.1) | unconfirmed |

## 7. Risks, open questions, and follow-up

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Type                                                                          | Next step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle interval                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Decided (owner, 2026-10-13)                                                   | 5 minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| One configuration per state file; credentials from the environment of the process that started the worker (a hook or a command that took over)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Decided (owner, 2026-10-13)                                                   | As 3.9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The whole feature ships in one release, with no mode switch; a downgrade runs `agent-presence worker --stop` first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Decided (owner, 2026-10-13)                                                   | As 4.1 and 4.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Node-free shell producer as the stable hook shim: Plan 0002's hook-command decision chose a stable shim file (owner, 2026-10-13); whether that shim runs without Node is this item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Owner                                                                         | A few milliseconds per hook, but `sh` cannot parse JSON, so it would record the raw payload, against S9; recommend not now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A producer's stop request for an older-version worker (3.3) carries the producer's own pid, but under 3.7 a request whose pid is no longer alive is stale and ignored, and the producer exits within milliseconds, so the old worker would ignore it; S7 relies on the new worker writing its own request (3.7). Same-version workers also yield the lock to each other's requests, so several new workers started during an upgrade burst may pass the lock back and forth. A producer that finds the lock held by a command, or by a worker that has not yet written `<state>.worker.v`, reads an earlier worker's version or `0` (3.3) and may start a worker and write a request that the holder's version did not call for | Open question                                                                 | Settle before Q1a; not resolved in this Plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A worker stuck in an iteration blocks takeovers and new workers until it is killed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Risk                                                                          | Abort signals and timeouts on external calls; automatic takeover after a stuck period as a follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Kit 0.13.0 offers no way to ask whether a process lock is held without taking it (3.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Kit gap ([agent-kit#106](https://github.com/PerfectPan/agent-kit/issues/106)) | Ask agent-kit for `isProcessLockHeld(platform: ProcessLockPlatform, path: string): Promise<boolean>` in `@rivus/agent-kit-collab/process-lock`. It never takes or keeps the lock, never writes `<path>.holder` and never makes a concurrent `acquireProcessLock` miss a free lock; it makes one attempt, without a busy timeout or settle retries; it reads no process identity on the SQLite path; checks running at the same moment do not make it report the lock held, so producers in a burst with no worker all find it free; a missing lock file reads as free and is not created. In a `node:sqlite` reproduction, a shared-lock read answered in about 0.5 ms whether the lock was held or free, and found it free while another check held its shared lock. Q1 waits for the release |
| A crash right after a producer found the worker lock held leaves that record pending until a later hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Accepted risk, decided (owner, 2026-10-13)                                    | As the Spec states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Upgrading from a release before the queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Decided (owner, 2026-10-13)                                                   | Uninstall the previous release with its own `agent-presence uninstall` first; no handling of a previous release running alongside (3.12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A flush the previous release scheduled before its uninstall still runs when due, and retries while the provider rate-limits it; its saves drop the queue fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Decided (owner, 2026-10-13)                                                   | Not handled (3.12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
