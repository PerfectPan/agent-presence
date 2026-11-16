#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { presenceShimPath } from '../src/harness/shim-path.js';
import { writePresenceShim } from '../src/harness/shim.js';
import { installDshPlugin, resolveDshPluginPaths } from '../src/installers.js';
import { assertSupportedPlatform } from '../src/platform.js';
import { reportDshPatchOutcome, runScriptMain } from './lib/cli.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
  if (!existsSync(presenceShimPath())) {
    await writePresenceShim(undefined, { mode: 'absolute' });
  }
  const result = await installDshPlugin(resolveDshPluginPaths());

  console.log(`installed dsh plugin: ${result.pluginPath}`);
  reportDshPatchOutcome(result);
}

runScriptMain(main);
