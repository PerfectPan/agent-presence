# Spec 0003: Hook Event Queue

## Status

Draft

Paired Plan: [`docs/plans/0003-hook-event-queue.md`](../plans/0003-hook-event-queue.md)

## Problem And Scope

Claude Code, Codex, Gemini CLI and Grok run presence as a command hook and wait for the command to exit before they
continue. Today the hook command does presence's own work before it prints its output: it updates the state file under
a lock, rescans transcripts for usage at session boundaries, and, when the last publish is older than the debounce
interval, reads the provider credential and publishes over the network. The agent waits for all of it.

This Spec makes the hook record the event and return. A background worker applies recorded events.

In scope: when the hook returns, what happens to an event afterwards, ordering, the worker's lifetime, crash and failure
behavior, the commands that change state, uninstall, upgrade and downgrade.

Out of scope: a resident system service (launchd, systemd); provider, render and usage behavior; how hook payloads are
interpreted (Spec and Plan 0002).

## Behavioral Requirements

- The hook command prints its output (`{}` unless `--silent`) and exits 0 once it has recorded the event. On its way it
  takes no lock, writes no log line, reads no credential, scans no transcript and makes no network call.
- A recorded event has the effect the current hook has on presence state (session, status, timestamps, reopen and
  session-boundary behavior, the fallback finish of the latest matching session), computed from the time the hook
  recorded it.
- Order: events that an agent sends one after another (each hook exits before the next one starts, as command hooks do)
  are applied in that order, unless the system clock steps backwards between them. Events recorded at the same time are
  applied in an unspecified order, as concurrent hooks race for the state lock today.
- Every recorded event changes the state exactly once, and its follow-up work takes effect exactly once: the usage
  numbers a dsh event carries and the usage refresh of each source that had a session boundary. This holds when the
  worker is killed at any point.
- Publishing keeps today's behavior and timing: after the events that change the rendered value, an event outside the
  debounce interval publishes and one inside it schedules a forced publish one debounce interval after that event;
  `reset --force` and the deferred `flush --force` publish without waiting. If a worker is killed during a publish, the
  next worker runs the sync again; because the interrupted publish already claimed the interval, that sync schedules the
  forced publish one debounce interval later.
- A background worker (`agent-presence worker`) applies recorded events. At most one worker runs per state file. A hook
  starts a worker when none is alive. The worker exits after the idle interval (default 5 minutes) once no event and no
  follow-up work is pending; a publish scheduled for later is handed to the deferred flush, as the hook hands it today.
- While a worker runs, a recorded event is applied to the state within 1 second, also while a publish or a usage scan is
  in progress. After a worker crash, the events pending at that moment are applied when a later hook or command runs.
- The commands that change state (`status`, `reset`, `flush`, `update`, including the shutdown watcher's `reset`) take
  over from a running worker, apply every event recorded before them, make their own change and report as they do today,
  with every option keeping its meaning. A running worker hands over within about a second. `reset` leaves usage
  refreshes to the next worker, so it takes no longer than applying the pending events and its own publish. A command
  that cannot take over within its wait (default 10 seconds, for example because a worker is stuck) fails as a command
  failure does today.
- `uninstall --all` stops the worker and removes recorded events together with the state; an event recorded by a hook
  that was already running when `uninstall --all` began is never applied. Until `setup` runs again,
  hooks that still fire record nothing, no worker starts, and the commands that change state change nothing. `uninstall`
  without `--all` changes neither.
- `agent-presence worker --stop` applies the pending events and stops the worker; from then on hooks of this release
  record nothing and no worker starts until `setup` runs again. A downgrade runs it first.
- If the event cannot be recorded (for example the disk is full), the hook still prints its output and exits 0; that
  event is lost.
- A recorded event holds presence's normalized fields only: source, event name, session id, project, subagent id and
  type, the model name and token and cost numbers of a dsh usage event, a skip or error code with the native event name,
  the environment values that locate an agent's transcripts (such as `CLAUDE_CONFIG_DIR`), and payload key names. It
  never holds prompt text, tool arguments or credentials. Recorded events live next to the state file with owner-only
  permissions and are deleted once applied.

## Unchanged Behavior

- The hook output contract (`{}` unless `--silent`; Codex hooks always get `{}`) and exit code 0.
- Session semantics (inactivity TTL, reopen on a new prompt, fallback finish), the source table, render templates,
  providers, the publishing behavior above, and the usage badge rules.
- The diagnostic log records payload key names only, never payload values.
- The state file gains only optional fields (the ids of applied events and pending follow-up work), which older releases
  drop when they load it.

## Domain Invariants

- A hook never blocks or fails the agent.
- One process per state file, the worker or a command that took over, applies events, and every state change goes
  through the state lock.
- An event is applied once: the state file records which events it already holds.

## Acceptance Examples

### S1: The hook returns without waiting for presence's work

- Given a provider whose publish takes 10 seconds and no publish within the last minute
- When a Codex hook fires for `SessionStart`
- Then the hook prints `{}` and exits within its usual start-up time, and the session is running in the state file
  within 1 second after the worker is ready, while the publish is still in progress

### S2: Sequential events

- Given an agent sends `SessionStart` and then `Stop` for one session, each hook exiting before the next starts, and the
  system clock does not step backwards between them
- When the worker applies them
- Then the session is finished

### S3: Burst

- Given 100 hooks fire at the same time
- When they have all exited
- Then one worker runs, and all 100 events are applied

### S4: Crash at any point

- Given a worker killed with SIGKILL after reading events, after saving the state, after deleting the applied files, or
  during a usage refresh or a dsh usage append
- When a later hook fires
- Then a worker applies every event exactly once, appends each dsh usage event once, and refreshes each owed source once

### S5: Idle exit

- Given no hook fires for 5 minutes and nothing is pending
- Then no worker process remains, and a publish scheduled for later is held by the deferred flush

### S6: Shutdown reset in order

- Given a `SessionStart` recorded and not yet applied, and a worker busy with a slow usage refresh
- When the shutdown watcher runs `reset --force --silent`
- Then `reset` takes over within about a second, applies the `SessionStart`, finishes every session and publishes, so no
  session is running afterwards; the usage refresh is done by the next worker

### S7: Upgrade

- Given a worker of the previous release is running
- When a hook of the new release records an event in a newer record version
- Then the old worker stops within about a second, and a worker of the new release applies the event

### S8: Disk full

- Given the directory for recorded events cannot be written
- When a hook fires
- Then it prints its output and exits 0

### S9: No payload values on disk

- Given a `UserPromptSubmit` payload carrying prompt text
- When the hook records it and the worker applies it
- Then no file next to the state file or under the presence home contains the prompt text

### S10: Uninstall everything

- Given recorded events pending and a worker running
- When `uninstall --all` runs, and a hook fires afterwards
- Then the worker has stopped, the state file is gone, the later hook records nothing, and no event recorded before or
  during the uninstall is applied after the next `setup`

## Compatibility And Constraints

- Platforms: macOS and Linux, the platforms presence supports.
- Upgrading from a release before the queue: uninstall that release with its own `agent-presence uninstall`, then
  install the new release and run `setup`. A deferred flush the previous release had already scheduled still runs that
  release's `flush` when due (and retries while the provider rate-limits it); it can race the worker, and this is not
  handled.
- Downgrade: run `agent-presence worker --stop` with the new release, then install the previous release, which ignores
  the queue.
- One state file uses one configuration: the worker reads the configuration file before each batch and uses the
  environment of the hook that started it for credentials.
- The worker uses `@rivus/agent-kit-collab`'s process lock and needs Node.js 22.13 or later, which presence already
  requires.

## Acceptance Evidence

- Scenario IDs and corresponding tests: not written yet; the paired Plan maps each scenario to a batch and test.
- Runtime evidence: not available yet; the Plan lists the latency, burst, crash and upgrade measurements.
