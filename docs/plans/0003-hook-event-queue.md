# Hook Event Queue

- Status: in review
- Owner: unconfirmed
- Reviewer: PerfectPan
- Last updated: 2026-10-11
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

Line references are to the code at the head of the Plan 0002 stack (batch 4).

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
  (`src/cli/hook-output.ts:16-18`), all through the log lock (`src/log.ts:23-26`). The diagnostic log records payload key
  names and a redacted session id, never payload values (`src/cli/hook-diagnostics.ts`).
- Measured on macOS (median of 20 runs, a fresh `HOME` each): one Codex `Heartbeat` run takes six locks (four log, two
  state). Hook cold start is 143 ms on `main` and 124 ms after Plan 0002's build split. With the kit's process lock in
  place of both locks (Plan 0002 batch 1, with PerfectPan/agent-kit#78) it measured 176 ms, mostly about 4-5 ms per
  acquisition, six times per run.

### 1.2 Problem

The agent waits for presence's state, usage and network work, and every hook takes locks on the agent's path. Moving
those locks to the kit's crash-safe process lock, which Plan 0002 batch 1 needs, makes each hook slower still.

### 1.3 Goals and success criteria

- The hook records the event and returns: no lock, log line, credential read, transcript scan or network call on its path
  (Spec 0003).
- Hook cold start at most 60 percent of `main`'s (about 85 ms against 143 ms, same measurement).
- One process per state file applies events in the Spec's order; each event's state change, dsh usage and usage refresh
  take effect exactly once across crashes; publishing behaves as today.
- The kit's process lock is used for what it is built for: one worker instance; the state and log locks leave the hook
  path.

### 1.4 Non-goals

- A system service (LaunchAgent, systemd unit) or an always-on daemon.
- A socket transport; it may come later as a wake-up hint, with the queue directory still the source of truth.
- A Node-free shell producer (section 7).
- Changes to interpretation rules (Plan 0002), providers, rendering, usage, or publishing behavior and timing.

## 2. Outline

### 2.1 Design principles

- Durable first: an event is on disk before the hook answers; the queue directory is the only source of truth.
- One applier per state file, and no lock or log write on the producer path.
- The state file records which events it holds and which follow-up work is still owed, in the same atomic save.
- Slow work never delays applying events, and anything that needs the applier's place takes it over through one
  mechanism: a stop request.

### 2.2 Boundaries and responsibilities

| Part                      | Owns                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Producer (`hook` command) | Interpreting the payload in process (Plan 0002 rules), writing one record, starting a worker if needed |
| Queue (`<state>.queue/`)  | Durable records; nothing else                                                                          |
| Worker (`worker` command) | Applying records (apply lane) and owed follow-up work and publishing (follow-up lane)                  |
| Commands                  | `status`, `reset`, `flush`, `update`, `worker --stop`, `uninstall --all`: take over, then act          |
| `@rivus/agent-kit-collab` | `acquireProcessLock` for the applier and for `withStateLock`                                           |

### 2.3 Main path

1. `hook` resolves the source, session, project and internal event name in process, writes a record (temporary file,
   then `rename`), starts a worker if none is alive (3.3), prints its output and exits.
2. The worker's apply lane lists the queue every 250 ms, applies the new records under the state lock, saves the state
   together with their ids and the follow-up work they owe, then deletes their files.
3. The follow-up lane works off owed dsh usage appends, per-source usage refreshes and the owed rendered sync, one at a
   time.
4. A command that changes state takes over from the worker (3.7), applies what is pending, and runs today's code.
5. After the idle interval with nothing pending, the worker exits (3.6).

### 2.4 Design decisions

| Decision          | Choice                                                                                        | Rejected                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Transport         | One file per event, `rename` into the queue directory                                         | Append-only file (rotation races); socket (loses events when nothing listens)                                         |
| Consumer lifetime | Started on demand, exits when idle                                                            | System service (install, upgrade and uninstall surface on two platforms, always resident)                             |
| Exactly once      | Applied record ids, owed dsh appends and owed per-source refreshes saved with the state       | Idempotent replay (fallback finish and reopen are not idempotent)                                                     |
| Publishing        | Today's rendered sync, owed as one `renderedSync` flag that the sync's own locked save clears | A publish debt with its outcome (today's sync claims the interval before publishing, so a replay returns "debounced") |
| Slow work         | A separate follow-up lane                                                                     | One loop (a slow publish delays every event)                                                                          |
| Taking over       | A stop request; the holder stops within an iteration and leaves owed work in the state        | Command records with results and deadlines (receipts and snapshots across lanes)                                      |
| Single applier    | `acquireProcessLock` on `<state>.worker.lock.db`, never deleted                               | PID file alone (stale after a crash); deleting the lock file (breaks mutual exclusion)                                |
| Liveness check    | `<state>.worker.json` (pid, record version) with a fresh mtime and a live pid                 | Taking the lock in the producer (puts a lock back on the hook path)                                                   |
| Record content    | Presence's normalized event                                                                   | Raw payload (prompt text and tool arguments on disk, Spec S9)                                                         |
| Order             | `rename` is the recording point; a batch sorts by recorded time                               | A monotonic clock across processes (needs a boot identity the producer cannot get cheaply)                            |
| Uninstall         | A `<state>.disabled` tombstone that producers and workers honor until `setup`                 | Waiting for the lock only (late hooks recreate the state)                                                             |
| Rollout           | The whole feature in one release, no mode switch                                              | A `direct`/`queue` switch (switching back can reorder pending events)                                                 |

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
- Variants, all with `v` (record version), `id` (the file name without extension) and `recordedAt` (wall-clock ms):

  | `kind`  | Fields                                                                                                                                        |
  | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
  | `event` | `source`, `event` (presence's internal name), `sessionId`, `project`, `subagent` (`id`, `type`), `usage` (dsh only), `scanEnv`, `payloadKeys` |
  | `skip`  | `code` (`missing-session-id`, `no-presence-source`, `ignored-event`), `source` or `agent`, `nativeEvent`, `payloadKeys`                       |
  | `error` | `code` (for example `handler-refused`, `resolver-failed`, `hook-load-failed`), `source` if known, a message without payload values            |
  - `usage` holds the normalized dsh usage event: `model` (a model name, needed for pricing, `src/usage/pricing.ts:122-128`)
    and the token and cost numbers (`src/usage-events.ts:63-71`); nothing else from the payload.
  - `scanEnv` holds the environment values that locate the source's transcripts (for example `CLAUDE_CONFIG_DIR`); Q1
    inventories them from the scanners. It is set on boundary events only and never carries credentials.
  - `payloadKeys` holds key names, for the diagnostic log.

- `v` increases on an incompatible change. A worker never applies a record with a higher `v` (3.7).

### 3.3 Starting a worker

- Before recording, a producer checks for `<state>.disabled` (3.8); if it exists, the producer records nothing.
- The worker writes `<state>.worker.json` (`pid`, `v`) and refreshes its mtime at the start of each apply-lane iteration.
- A producer starts a worker when that file is missing, its mtime is older than 3 seconds, its `pid` is not alive
  (`process.kill(pid, 0)`), or its `v` is lower than the producer's record version (then it also writes a stop request,
  3.7).
- A worker crash leaves a file with a dead pid, so the next producer starts a worker. A crash right after a producer saw
  the old worker alive leaves that producer's record pending until a later hook or command (Spec).

### 3.4 Order

- The recording point is the `rename`. A command hook exits only after its `rename`, and the agent starts its next hook
  for that session after the previous one exits, so sequential events have increasing `recordedAt` unless the system
  clock steps backwards, and the later one is never applied in an earlier batch.
- Each batch is applied sorted by `recordedAt`, then by file name. Events recorded concurrently (opencode and Pi bridges
  that do not wait, parallel tool calls) have no defined order, as today.

### 3.5 Applying exactly once

The state file gains two optional fields that `normalizeState` keeps and older releases drop:

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
  lane is off the hook path), with the record id in the entry; the usage scanner skips a repeated id. The item leaves
  `queueOwed` only after the append wrote.
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

A stop request that is not the holder's own aborts the item in progress through its abort signal (the refresh's scans,
the publish's request), so the holder stops within about a second; an aborted item stays owed. The holder releases the
lock only after the apply lane's current batch has saved or been dropped and the follow-up item has ended, with any
rollback it triggers saved, so no write of the old holder lands after the new holder starts.

### 3.6 Idle exit

After the idle interval with an empty queue and an empty `queueOwed`:

1. Delete `<state>.worker.json`.
2. List the queue once more. If a record is there, rewrite the file and continue.
3. Release the lock and exit. Nothing slow runs after step 1.

A producer renames its record, then checks the liveness file. A record renamed before step 2 is seen in step 2; one
renamed after it is followed by a check that finds no liveness file, so its producer starts a worker, which waits up to
5 seconds for the lock. A scheduled publish is already held by the deferred flush the sync spawned.

### 3.7 Taking over

- A process that needs the applier's place writes its own request file `<state>.worker.stop.<token>` holding its pid,
  and waits for the lock: a command up to 10 seconds, a newer-version worker up to 60 seconds. A request whose pid is no
  longer alive is stale: any holder deletes it and ignores it. A requester deletes its own file when it gets the lock or
  gives up.
- A holder that finds a live request that is not its own stops at its next apply-lane iteration or between follow-up
  items: it aborts the item in progress, deletes its liveness file and releases the lock. A worker that wins
  the lock from another contender does the same, so the lock passes on until the requester holds it.
- The requester, holding the lock, deletes its request, then:
  - a newer-version worker continues as the worker, applying the records the old one left;
  - `status`, `flush` and `update` apply the pending records and append the owed dsh usage (apply-lane steps 1-3 and the
    dsh items), then run today's command code; `flush` and `update` clear `renderedSync` through their own sync;
  - `reset` applies the pending records only, finishes every session and publishes, clearing `renderedSync`; its time is
    bounded by the takeover wait, one in-memory pass with one save over the pending records, the credential read and
    publish timeouts, and exiting (it waits for no background work it started) (Spec S6);
  - `worker --stop`: 3.8.
- Whether it succeeds or fails, a command that took over starts a background worker before it exits if records or owed
  work remain.
- The shutdown watcher runs `reset --force --silent` and waits for it without a deadline, so the bound above is the
  shutdown delay. `--silent` keeps its meaning.
- A command that cannot take the lock within its wait fails as a command failure does today.

### 3.8 Uninstall and setup

- `<state>.epoch` holds a number that producers copy into each record; workers and commands apply only records whose
  epoch matches the file. `setup`, when it removes a tombstone, increases it.
- `<state>.disabled` is a tombstone. Producers check it before recording, workers before starting and at every
  iteration, and `status`, `reset`, `flush` and `update` right after taking over. While it exists, producers record
  nothing, workers exit, and those commands change nothing.
- `uninstall --all` writes the tombstone, takes over, deletes the queue directory and the liveness and stop-request files,
  then the state as today. It keeps `<state>.worker.lock.db`, its holder file and `<state>.epoch`. A producer that passed
  its tombstone check just before can still write one record afterwards; nothing applies it while the tombstone exists,
  and after `setup` its old epoch makes every applier delete it unapplied.
- `worker --stop` takes over, applies the pending records, works off the owed items, writes the tombstone and exits. From
  then on new-release hooks record nothing and no new-release worker starts, so the previous release can be installed; it
  ignores the tombstone and the queue.
- `setup` of the new release, when it finds the tombstone, takes over, deletes every record in the queue (each was
  recorded before or around an uninstall or a downgrade) and then the tombstone. Without a tombstone it leaves the queue
  alone.
- `uninstall` without `--all` changes none of these; the worker exits when idle.

### 3.9 Configuration and credentials

- One state file, one configuration. The worker reads the configuration file before each batch and uses the environment
  of the hook that started it for credentials (`src/secret.ts:41-57`) and provider overrides. A hook whose environment
  differs (another credential, another state or config path) for the same state file is not supported; section 7.
- Transcript roots travel with boundary events in `scanEnv`.
- Records never carry credentials.

### 3.10 Failures

| Failure                  | Behavior                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Record cannot be written | The hook prints its output and exits 0; the event is lost (Spec S8)                           |
| Worker cannot be started | Records wait; the next producer tries again                                                   |
| Worker killed            | The kernel releases the SQLite lock; `queueApplied` and `queueOwed` finish the work (Spec S4) |
| Worker stuck             | Liveness ages; takeovers time out and commands fail; records wait; section 7                  |
| Bad record               | Moved to `<state>.queue/failed/` (kept 7 days), logged, skipped                               |
| Large backlog            | Nothing is dropped; above 10,000 records the worker logs a warning                            |
| External call hangs      | Scans and the publish take an abort signal and a timeout; the apply lane continues            |

### 3.11 Logs

The producer writes no log line. Source resolution returns its diagnostics instead of writing them, and the producer
records them as `error` records; the hook-module load fallback records an `error` record, and if recording fails too it
only prints the output. The worker writes the diagnostic line for each event (payload key names), the line the hook
writes today for each `skip` and `error` record, and `worker.start`, `worker.exit` with its reason, batch sizes, failed
records and backlog warnings.

### 3.12 Compatibility and migration

- Hook commands of the new release record from their first run, whatever form they were installed in.
- Hooks installed by a previous release with a version-pinned `npx` command (`src/installers.ts:371-375`) keep running
  that release's direct code until `setup` runs again.
- A deferred flush scheduled by a previous release (`deferred-update.ts:9-24`) runs that release's `flush`; when the
  provider rate-limits it, that `flush` schedules its own retries (`deferred-update.ts:78-87`). It ignores the queue and
  the tombstone, and each of its saves drops `queueApplied` and `queueOwed`: after such a save at most the records of one
  batch can be applied twice, and the owed items of that moment are lost. This lasts until that release's retries stop;
  section 7 asks the owner to accept it.
- Downgrade: `agent-presence worker --stop` with the new release, then install the previous release.

### 3.13 Security and privacy

- Records carry the fields in 3.2 only (Spec S9), in a 0700 directory with 0600 files, deleted once applied; failed
  records keep the same fields for 7 days.
- The worker runs as the user and listens on nothing.

## 4. Rollout and stability

### 4.1 Gates and rollout stages

The queue, the producer, the worker, the takeover by commands, the tombstone and `worker --stop` ship together in one
release (Q1). There is no mode switch.

### 4.2 Signals and alerts

The worker's log lines (3.11). `status` output does not change.

### 4.3 Rollback

`agent-presence worker --stop`, then downgrade to the previous release (3.12).

## 5. Verification

### 5.1 Functional checks

- Record codec, writer and sorter; interpretation to record, one case per row of Plan 0002's event table.
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
- Idle-exit race: producers recording while a worker exits, 1,000 iterations with random delays: no record stays.
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

- Hook cold start, median of 20 runs with a fresh `HOME`: `main` against the Q1 producer; target at most 60 percent.
- Event-to-state latency with a running worker and a slow publish in progress: under 1 second.
- 100 concurrent hooks: one worker, every event applied (Spec S3).

## 6. Execution plan

### 6.1 Preconditions

- Plan 0002 batches 3 and 4 merged (lazy command loading, the interpretation the producer reuses).
- The kit release with PerfectPan/agent-kit#78, for `acquireProcessLock` with the zod-free platform entry.
- The decisions in section 7 marked as needed before Q1 settled.

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

- Files: new `src/queue/` (record codec, writer, reader, liveness, stop request, tombstone), `src/cli/commands/worker.ts`,
  `src/state.ts` (`queueApplied`, `queueOwed`, `withStateLock` on the kit's process lock, from the Plan 0002 batch 1
  branch), the shared lazy platform module from that branch, `src/usage-events.ts` (an append that waits for the log lock and carries the record id) and
  the dsh usage scanner (skip repeated ids), `src/cli/usage-badge.ts` (an abort signal and a completion result), `package.json` (`@rivus/agent-kit-collab`), tests.
- The worker runs from tests and from `agent-presence worker`; nothing writes records yet, so behavior does not change.
- Exit: 5.2's worker checks pass; gates.

#### Q1b: producer, commands, uninstall (one PR, released with Q1a)

- Files: `src/cli/commands/hook.ts` (producer), `src/sources.ts` (diagnostics returned instead of written),
  `src/cli/hook-output.ts` (error record), `src/cli/app.ts` (`worker`), `src/cli/commands/{status,reset,flush,update,uninstall}.ts`
  (takeover), `src/setup.ts` (tombstone removal), `docs/architecture.md`, a changeset.
- Exit: every scenario in 6.2, the cold-start target, gates.

#### Q2: cleanup

- Remove the direct application path from `hook` and the code only it used.

Relation to Plan 0002: Q1 replaces batch 1's design; the batch 1 branch supplies `withStateLock` on the kit lock, the
shared platform module and their tests.

### 6.4 Validation ledger

| Batch | Command or evidence                      | Expected result                                   |
| ----- | ---------------------------------------- | ------------------------------------------------- |
| Q1a   | Crash, takeover and idle-race tests      | No lost, doubled or stranded event or owed item   |
| Q1b   | Event table through producer and worker  | Same state as the direct path for all 67 cases    |
| Q1b   | Hook cold start against `main`           | At most 60 percent                                |
| Q1b   | `reset` during a slow refresh; uninstall | No running session within the bound; nothing left |
| all   | Repository gates                         | Pass                                              |

### 6.5 Work split and schedule

| Batch | Owner       | Depends on                                 | When        |
| ----- | ----------- | ------------------------------------------ | ----------- |
| Q1a   | unconfirmed | Plan 0002 batches 3 and 4, the kit release | unconfirmed |
| Q1b   | unconfirmed | Q1a                                        | unconfirmed |
| Q2    | unconfirmed | Q1b released                               | unconfirmed |

## 7. Risks, open questions, and follow-up

| Item                                                                                                                                                                                                                 | Type          | Next step                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idle interval (proposed 5 minutes)                                                                                                                                                                                   | Owner, Q1     | Confirm or change                                                                                                                                                                                                  |
| One configuration per state file; credentials from the environment of the hook that started the worker                                                                                                               | Owner, Q1     | Confirm, or require per-event configuration identity (a worker per identity)                                                                                                                                       |
| Node-free shell producer as the stable hook shim (Plan 0002's hook-command decision)                                                                                                                                 | Owner         | A few milliseconds per hook, but `sh` cannot parse JSON, so it would record the raw payload, against S9; recommend not now                                                                                         |
| A worker stuck in an iteration blocks takeovers and new workers until it is killed                                                                                                                                   | Risk          | Abort signals and timeouts on external calls; automatic takeover after a stuck period as a follow-up                                                                                                               |
| A worker pid reused within the 3-second liveness window hides a dead worker until the window passes                                                                                                                  | Accepted risk | The next hook after the window starts a worker                                                                                                                                                                     |
| A crash right after a producer saw the old worker alive leaves that record pending until a later hook                                                                                                                | Accepted risk | As the Spec states                                                                                                                                                                                                 |
| A previous release's version-pinned hooks race the worker until `setup` runs                                                                                                                                         | Accepted risk | Plan 0002 batch 5's `setup` replaces the installed commands                                                                                                                                                        |
| A previous release's scheduled flush keeps rescheduling itself while the provider rate-limits it (`deferred-update.ts:78-87`); its saves drop the queue fields and can recreate a state removed by `uninstall --all` | Owner, Q1     | (a) Accept the race until those retries stop; (b) make `setup` and `uninstall` terminate previous releases' deferred-flush timer processes (detached `node -e` processes whose arguments name a presence CLI path) |
