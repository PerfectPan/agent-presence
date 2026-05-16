# RFC: Linux Power / Session Watcher

**Status**: Skipped (TTL pruning covers expired sessions)

**Date**: 2026-05-16

## Background

On macOS, agent-presence installs a LaunchAgent that watches `NSWorkspace` sleep/wake
notifications and runs `agent-presence reset --force` when the machine sleeps, wakes,
or the user logs out. This keeps the Feishu signature accurate across power events.

On Linux, the equivalent would need to detect suspend/resume, session lock/unlock,
and user logout. The natural path is a systemd user service listening to logind
D-Bus signals (`PrepareForSleep`, `Lock`, `Unlock`, `SessionRemoved`).

## Attempted Approaches

### systemd user service + logind D-Bus

A systemd user unit would subscribe to `org.freedesktop.login1.Manager` signals:

- `PrepareForSleep` — reset before suspend
- `Lock` / `Unlock` — reset on session lock
- `SessionRemoved` — reset on logout

The service would invoke `agent-presence reset --force --silent`.

### Why this was skipped

After analysis, the following issues make a reliable Linux watcher problematic
for the current release:

1. **Distribution fragmentation**: systemd user service behavior, default
   service search paths, and `loginctl` D-Bus signal semantics vary across
   distributions (Ubuntu, Debian, Fedora, Arch, etc.).

2. **D-Bus session bus availability**: The session D-Bus bus is not available
   in headless environments, SSH sessions, or some container runtimes. A watcher
   that silently fails in these contexts is worse than no watcher.

3. **systemd user instance availability**: Some distributions disable the
   systemd user instance by default. Others require `linger` to be enabled
   for user services to persist after logout.

4. **Partial picture coverage**: Even with logind signals, the watcher cannot
   detect all relevant events (e.g., `SIGKILL` of the agent process before
   a finish hook fires). TTL pruning already handles those cases.

5. **Testing surface**: Verifying systemd user unit behavior across Linux
   distributions would significantly expand the test matrix without clear
   safety benefit over TTL pruning alone.

## Current Mitigation

TTL pruning (3 minutes by default) handles the primary failure mode: sessions
where the agent process exits without a finish hook. This covers:

- Agent crashes and hard kills
- Terminal closures
- Network disconnections without clean shutdown
- Any situation where the coding agent stops producing heartbeat events

The gap that a watcher would close is minimal: a suspend/resume cycle where
no heartbeat TTL has expired yet. In practice, suspend cycles are typically
longer than the 3-minute TTL, so most sessions already expire naturally.

## Future Requirements

A Linux watcher should be reconsidered when:

1. systemd user instances are reliably available on the majority of
   distributions used by agent-presence users.
2. A lightweight D-Bus library (or `busctl` / `gdbus` CLI) proves
   to be reliably present on target distributions.
3. The install/uninstall path is as simple as copying a user unit file
   to `~/.config/systemd/user/` and running `systemctl --user enable`.
4. Testing covers suspend/resume simulation and session lock/unlock
   across at least two major distributions.

## References

- [systemd logind D-Bus API](https://www.freedesktop.org/wiki/Software/systemd/logind/)
- [systemd user services](https://wiki.archlinux.org/title/Systemd/User)
