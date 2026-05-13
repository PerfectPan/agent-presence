#!/usr/bin/env node
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { buildPowerEventWatcherSwift, buildShutdownWatcherPlist, buildShutdownWatcherScript } from '../src/installers.js';
import { assertSupportedPlatform } from '../src/platform.js';

const execFileAsync = promisify(execFile);
const LABEL = 'work.rivus.agent-presence.power-watch';
const LEGACY_LABEL = 'work.garyyang.agent-signature.shutdown-watch';

async function main(): Promise<void> {
  assertSupportedPlatform();
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
  const logPath =
    process.env.AGENT_PRESENCE_POWER_WATCHER_LOG ??
    process.env.AGENT_SIGNATURE_SHUTDOWN_WATCHER_LOG ??
    join(home, '.agent-presence', 'power-watch.log');
  const legacyPlistPath = join(home, 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);

  await mkdir(dirname(scriptPath), { recursive: true, mode: 0o700 });
  await writeFile(scriptPath, buildShutdownWatcherScript({ pathEntries: [dirname(process.execPath)], powerEventWatcherPath: powerWatcherPath }), { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  await writeFile(powerWatcherPath, buildPowerEventWatcherSwift(), { mode: 0o700 });
  await chmod(powerWatcherPath, 0o700);

  await mkdir(dirname(plistPath), { recursive: true, mode: 0o700 });
  await writeFile(
    plistPath,
    buildShutdownWatcherPlist({
      label: LABEL,
      scriptPath,
      logPath,
      errorLogPath: logPath
    }),
    { mode: 0o600 }
  );

  const domain = `gui/${currentUid()}`;
  await launchctl(['bootout', domain, legacyPlistPath]).catch(() => undefined);
  await rm(legacyPlistPath, { force: true });
  await launchctl(['bootout', domain, plistPath]).catch(() => undefined);
  await launchctl(['bootstrap', domain, plistPath]);
  await launchctl(['enable', `${domain}/${LABEL}`]).catch(() => undefined);
  console.log(`installed shutdown watcher: ${plistPath}`);
  console.log(`installed power event watcher: ${powerWatcherPath}`);
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
