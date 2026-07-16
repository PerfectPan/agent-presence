# RFC: Bounded Diagnostic Log Retention

**Status**: Accepted

**Date**: 2026-07-17

## Problem

`agent-presence.log` and the macOS `power-watch.log` are diagnostic files, not
durable application state, but both previously grew without a retention policy.
A noisy provider failure, malformed hook error, or repeatedly failing watcher
could therefore consume disk indefinitely.

## Goals

- Bound both diagnostic logs without adding a separate daemon on Linux.
- Retain recent troubleshooting context instead of deleting the whole file.
- Preserve the existing log path and inode where long-running processes hold the
  file open.
- Keep cleanup failures from breaking hook, provider, or power-watcher behavior.
- Serialize main-log compaction across concurrent hook processes.

## Non-Goals

- Long-term log archives or time-based retention.
- User-configurable thresholds in this release.
- Managing logs written by user-supplied source handlers outside the configured
  `agent-presence` log path.

## Proposed Design

The shared policy is a 5 MiB trigger and a retained tail of roughly 1 MiB.

The main log owns its append boundary in `src/log-retention.ts`. Writers use a
short-lived sibling lock file with an agent-presence owner token, append the new
line, then compact the file in place when it exceeds the threshold. Appending
first means a single oversized event is bounded immediately. Foreign data at the
lock path is never deleted. If the filesystem cannot create the lock or the path
belongs to something else, the event is appended without maintenance; if a
verified live owner remains contended, the diagnostic write is skipped instead
of racing an in-progress truncate. A lock becomes reclaimable only after its
owner PID is no longer alive and its mtime is at least 2 seconds old. Before
unlinking that generation, a reclaimer must atomically hard-link its inode to a
fixed reclaim path; this admits exactly one reclaimer and prevents a delayed
unlink from deleting a newer lock.

The macOS watcher has two independent failure surfaces:

- The generated zsh wrapper compacts before starting Swift and before every
  restart, covering compiler and startup-error loops.
- The long-running Swift watcher compacts at startup and once every 86,400
  seconds, covering runtime output without another process or LaunchAgent.

All implementations preserve the most recent bytes, including oversized
single-line diagnostics, and truncate the existing file instead of replacing
it because launchd owns the stdout and stderr file descriptors. A compacted file
may begin mid-line.

## Alternatives Considered

- **System `logrotate`**: not consistently installed or configured on macOS and
  would add an external setup dependency.
- **A second daily LaunchAgent**: adds install, uninstall, and failure lifecycle
  for a task the existing watcher can own.
- **Delete the log at a fixed interval**: simple but removes the context users
  need when investigating a failure.
- **Time-based line parsing**: requires scanning an unbounded file before the
  first cleanup and couples retention to timestamp parsing.

## Rollout Plan

- Ship as a patch release with a changeset.
- Main logs adopt retention on the first write made by the new package.
- Fresh macOS setup installs the bounded watcher artifacts.
- Existing macOS users rerun `agent-presence setup --skip-login` once after
  upgrading so the persistent shell and Swift watcher files are regenerated.
- No config or state migration is required.

## Risks

- A process crash can leave the owner-marked lock file behind; verified locks
  whose owner PID is gone and whose mtime is older than 2 seconds are reclaimed.
  A still-contended diagnostic write is skipped rather than risking deletion by
  an in-progress compaction.
- A process crash during the small reclaim critical section can leave the fixed
  reclaim hard link behind. Normal lock generations still work, but a later
  stale generation cannot be reclaimed until that coordination artifact is
  removed.
- In-place compaction can race with processes from an older package version that
  do not use the lock. This is limited to the upgrade window.
- A single event larger than the retained tail is truncated to its most recent
  bytes rather than preserved in full.
