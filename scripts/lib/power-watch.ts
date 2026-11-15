// The launchd plumbing both power-watch scripts share: the labels, `launchctl`, the uid, and the file paths the
// environment can override.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const POWER_WATCH_LABEL = 'work.rivus.agent-presence.power-watch';
const LEGACY_POWER_WATCH_LABEL = 'work.garyyang.agent-signature.shutdown-watch';

export async function launchctl(args: string[]): Promise<void> {
  await execFileAsync('launchctl', args);
}

export function currentUid(): number {
  if (!process.getuid) {
    throw new Error('process.getuid is unavailable on this platform');
  }
  return process.getuid();
}

/** The power-watch files: the environment's path for each, or the default under the home directory. */
export function powerWatchPaths() {
  const home = homedir();
  return {
    scriptPath:
      process.env.AGENT_PRESENCE_POWER_WATCHER_SCRIPT ??
      process.env.AGENT_SIGNATURE_SHUTDOWN_WATCHER_SCRIPT ??
      join(home, '.agent-presence', 'power-watch.sh'),
    powerWatcherPath:
      process.env.AGENT_PRESENCE_POWER_WATCHER_SWIFT ??
      process.env.AGENT_SIGNATURE_POWER_WATCHER_SWIFT ??
      join(home, '.agent-presence', 'power-watch.swift'),
    plistPath:
      process.env.AGENT_PRESENCE_POWER_WATCHER_PLIST ??
      process.env.AGENT_SIGNATURE_SHUTDOWN_WATCHER_PLIST ??
      join(home, 'Library', 'LaunchAgents', `${POWER_WATCH_LABEL}.plist`),
    logPath:
      process.env.AGENT_PRESENCE_POWER_WATCHER_LOG ??
      process.env.AGENT_SIGNATURE_SHUTDOWN_WATCHER_LOG ??
      join(home, '.agent-presence', 'power-watch.log'),
    legacyPlistPath: join(home, 'Library', 'LaunchAgents', `${LEGACY_POWER_WATCH_LABEL}.plist`)
  };
}
