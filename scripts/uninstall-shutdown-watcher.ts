#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertMacOS } from '../src/platform.js';

const execFileAsync = promisify(execFile);
const LABEL = 'work.rivus.agent-presence.power-watch';
const LEGACY_LABEL = 'work.garyyang.agent-signature.shutdown-watch';

async function main(): Promise<void> {
  assertMacOS();
  const home = homedir();
  const scriptPath =
    process.env.AGENT_PRESENCE_POWER_WATCHER_SCRIPT ??
    process.env.AGENT_SIGNATURE_SHUTDOWN_WATCHER_SCRIPT ??
    join(home, '.agent-presence', 'power-watch.sh');
  const powerWatcherPath =
    process.env.AGENT_PRESENCE_POWER_WATCHER_SWIFT ??
    process.env.AGENT_SIGNATURE_POWER_WATCHER_SWIFT ??
    join(home, '.agent-presence', 'power-watch.swift');
  const plistPath =
    process.env.AGENT_PRESENCE_POWER_WATCHER_PLIST ??
    process.env.AGENT_SIGNATURE_SHUTDOWN_WATCHER_PLIST ??
    join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const legacyPlistPath = join(home, 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);
  const legacyScriptPath = join(home, '.codex', 'agent-signature', 'shutdown-watch.sh');
  const legacyPowerWatcherPath = join(home, '.codex', 'agent-signature', 'power-watch.swift');

  await launchctl(['bootout', `gui/${currentUid()}`, plistPath]).catch(() => undefined);
  await launchctl(['bootout', `gui/${currentUid()}`, legacyPlistPath]).catch(() => undefined);
  await rm(plistPath, { force: true });
  await rm(legacyPlistPath, { force: true });
  await rm(scriptPath, { force: true });
  await rm(powerWatcherPath, { force: true });
  await rm(legacyScriptPath, { force: true });
  await rm(legacyPowerWatcherPath, { force: true });
  console.log(`removed power watcher: ${plistPath}`);
}

async function launchctl(args: string[]): Promise<void> {
  await execFileAsync('launchctl', args);
}

function currentUid(): number {
  if (!process.getuid) {
    throw new Error('process.getuid is unavailable on this platform');
  }
  return process.getuid();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
