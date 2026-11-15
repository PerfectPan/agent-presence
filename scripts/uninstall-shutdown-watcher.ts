#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertMacOS } from '../src/platform.js';
import { runScriptMain } from './lib/cli.js';
import { currentUid, launchctl, powerWatchPaths } from './lib/power-watch.js';

async function main(): Promise<void> {
  assertMacOS();
  const { scriptPath, powerWatcherPath, plistPath, legacyPlistPath } = powerWatchPaths();
  const home = homedir();
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

runScriptMain(main);
