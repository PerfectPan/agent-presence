#!/usr/bin/env node
import { resolveDshPluginPaths, uninstallDshPlugin } from '../src/installers.js';
import { assertSupportedPlatform } from '../src/platform.js';
import { reportDshPatchOutcome, runScriptMain } from './lib/cli.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
  const result = await uninstallDshPlugin(resolveDshPluginPaths());

  console.log(`${result.status === 'removed' ? 'removed' : 'kept'} dsh plugin: ${result.pluginPath}`);
  reportDshPatchOutcome(result);
}

runScriptMain(main);
