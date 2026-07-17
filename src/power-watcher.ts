import { LOG_MAX_BYTES, LOG_RETAIN_BYTES } from './log-retention.js';
import { buildAgentPresenceShellCommand } from './installers.js';

export interface PowerWatcherPlistOptions {
  label: string;
  scriptPath: string;
  logPath?: string;
  errorLogPath?: string;
}

export interface PowerWatcherScriptOptions {
  pathEntries?: string[];
  powerEventWatcherPath?: string;
  logPath?: string;
}

export interface PowerEventWatcherOptions {
  logPath?: string;
}

export function buildPowerWatcherScript(options: PowerWatcherScriptOptions = {}): string {
  const pathEntries = (options.pathEntries ?? []).filter((entry) => entry.length > 0);
  const pathExport = pathEntries.length > 0 ? `export PATH="${escapeShellDoubleQuoted(pathEntries.join(':'))}:$PATH"\n\n` : '';
  const logMaintenance = options.logPath
    ? `prune_log() {
  log_path="${escapeShellDoubleQuoted(options.logPath)}"
  if [ ! -f "$log_path" ]; then
    return
  fi

  log_size=$(/usr/bin/stat -f%z "$log_path" 2>/dev/null || echo 0)
  if [ "$log_size" -le ${LOG_MAX_BYTES} ]; then
    return
  fi

  retained_log="$log_path.retained.$$"
  if ! /usr/bin/tail -c ${LOG_RETAIN_BYTES} "$log_path" > "$retained_log" 2>/dev/null; then
    /bin/rm -f "$retained_log"
    return
  fi
  if ! /bin/cat "$retained_log" > "$log_path"; then
    /bin/rm -f "$retained_log"
    return
  fi
  /bin/rm -f "$retained_log"
}

`
    : '';
  const pruneLog = options.logPath ? '  prune_log\n' : '';
  const powerWatcherLoop = options.powerEventWatcherPath
    ? `while true; do
${pruneLog}\
  if [ -x /usr/bin/swift ] && [ -f "${escapeShellDoubleQuoted(options.powerEventWatcherPath)}" ]; then
    /usr/bin/swift "${escapeShellDoubleQuoted(options.powerEventWatcherPath)}" &
    watcher_pid=$!
    wait "$watcher_pid" || true
    watcher_pid=""
  else
    sleep 3600 &
    watcher_pid=$!
    wait "$watcher_pid" || true
    watcher_pid=""
  fi
  sleep 2
done`
    : `while true; do
${pruneLog}\
  sleep 3600 &
  watcher_pid=$!
  wait "$watcher_pid" || true
  watcher_pid=""
done`;
  return `#!/bin/zsh
set -u

${pathExport}\
${logMaintenance}\
watcher_pid=""

cleanup() {
  if [ -n "\${watcher_pid:-}" ]; then
    kill "$watcher_pid" >/dev/null 2>/dev/null || true
  fi
  ${buildAgentPresenceShellCommand(['reset', '--force', '--silent'])} >/dev/null 2>/dev/null || true
}

trap cleanup TERM HUP INT EXIT

${powerWatcherLoop}
`;
}

export function buildPowerEventWatcherSwift(options: PowerEventWatcherOptions = {}): string {
  const logMaintenance = options.logPath
    ? `
let watcherLogPath = "${escapeSwiftString(options.logPath)}"
let watcherLogMaxBytes: UInt64 = ${LOG_MAX_BYTES}
let watcherLogRetainBytes = ${LOG_RETAIN_BYTES}

func pruneWatcherLog() {
    do {
        let attributes = try FileManager.default.attributesOfItem(atPath: watcherLogPath)
        guard let size = attributes[.size] as? NSNumber,
              size.uint64Value > watcherLogMaxBytes else {
            return
        }

        let url = URL(fileURLWithPath: watcherLogPath)
        let contents = try Data(contentsOf: url)
        let tail = contents.suffix(watcherLogRetainBytes)
        let retainedTail = Data(tail)

        let file = try FileHandle(forWritingTo: url)
        defer { try? file.close() }
        try file.truncate(atOffset: 0)
        try file.write(contentsOf: retainedTail)
    } catch {
        // Log retention is diagnostic only and must never stop the watcher.
    }
}
`
    : '';
  const logMaintenanceSetup = options.logPath
    ? `
pruneWatcherLog()
_ = Timer.scheduledTimer(withTimeInterval: 86_400, repeats: true) { _ in
    pruneWatcherLog()
}
`
    : '';
  return `#!/usr/bin/env swift
import AppKit
import Foundation
${logMaintenance}

func resetPresence(reason: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/zsh")
    task.arguments = ["-lc", "${escapeSwiftString(buildAgentPresenceShellCommand(['reset', '--force', '--silent']))} >/dev/null 2>/dev/null || true"]
    task.environment = ProcessInfo.processInfo.environment
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        // Never let the watcher crash because reset failed.
    }
}

let center = NSWorkspace.shared.notificationCenter
let notifications: [Notification.Name] = [
    NSWorkspace.willSleepNotification,
    NSWorkspace.screensDidSleepNotification,
    NSWorkspace.didWakeNotification,
    NSWorkspace.screensDidWakeNotification
]

for name in notifications {
    center.addObserver(forName: name, object: nil, queue: .main) { notification in
        resetPresence(reason: notification.name.rawValue)
    }
}
${logMaintenanceSetup}

RunLoop.main.run()
`;
}

export function buildPowerWatcherPlist(options: PowerWatcherPlistOptions): string {
  const logPath = options.logPath ?? '/tmp/agent-presence-power-watch.log';
  const errorLogPath = options.errorLogPath ?? logPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${escapePlist(options.scriptPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(errorLogPath)}</string>
</dict>
</plist>
`;
}

function escapePlist(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeShellDoubleQuoted(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`');
}

function escapeSwiftString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
