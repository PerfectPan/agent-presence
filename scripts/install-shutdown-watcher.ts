#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { presenceShimPath } from '../src/harness/shim-path.js';
import { writePresenceShim } from '../src/harness/shim.js';
import { assertMacOS } from '../src/platform.js';
import { buildPowerEventWatcherSwift, buildPowerWatcherPlist, buildPowerWatcherScript } from '../src/power-watcher.js';
import { runScriptMain } from './lib/cli.js';
import { POWER_WATCH_LABEL, currentUid, launchctl, powerWatchPaths } from './lib/power-watch.js';

async function main(): Promise<void> {
  assertMacOS();
  if (!existsSync(presenceShimPath())) {
    await writePresenceShim(undefined, { mode: 'absolute' });
  }
  const { scriptPath, powerWatcherPath, plistPath, logPath, legacyPlistPath } = powerWatchPaths();

  await mkdir(dirname(scriptPath), { recursive: true, mode: 0o700 });
  await writeFile(
    scriptPath,
    buildPowerWatcherScript({
      pathEntries: [dirname(process.execPath)],
      powerEventWatcherPath: powerWatcherPath,
      logPath
    }),
    { mode: 0o700 }
  );
  await chmod(scriptPath, 0o700);
  await writeFile(powerWatcherPath, buildPowerEventWatcherSwift({ logPath }), { mode: 0o700 });
  await chmod(powerWatcherPath, 0o700);

  await mkdir(dirname(plistPath), { recursive: true, mode: 0o700 });
  await writeFile(
    plistPath,
    buildPowerWatcherPlist({
      label: POWER_WATCH_LABEL,
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
  await launchctl(['enable', `${domain}/${POWER_WATCH_LABEL}`]).catch(() => undefined);
  console.log(`installed shutdown watcher: ${plistPath}`);
  console.log(`installed power event watcher: ${powerWatcherPath}`);
}

runScriptMain(main);
