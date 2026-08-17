#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DSH_PLUGIN_FILE_NAME, installDshPlugin } from '../src/installers.js';
import { assertSupportedPlatform } from '../src/platform.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const pluginPath =
    process.env.DSH_AGENT_PRESENCE_PLUGIN_FILE ?? join(dshHome, 'plugins', DSH_PLUGIN_FILE_NAME);
  const patchPath = process.env.DSH_AGENT_PRESENCE_PATCH_FILE ?? join(dshHome, 'cordis.patch.yml');

  const result = await installDshPlugin({ pluginPath, patchPath });

  console.log(`installed dsh plugin: ${result.pluginPath}`);
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
