#!/usr/bin/env node
import { resolveDshPluginPaths, uninstallDshPlugin } from '../src/installers.js';
import { assertSupportedPlatform } from '../src/platform.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
  const result = await uninstallDshPlugin(resolveDshPluginPaths());

  console.log(`${result.status === 'removed' ? 'removed' : 'kept'} dsh plugin: ${result.pluginPath}`);
  if (result.patchUpdated) {
    console.log(`updated dsh patch: ${result.patchPath}`);
  } else if (result.patchError) {
    console.warn(`warning: could not update dsh patch at ${result.patchPath}: ${result.patchError}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
