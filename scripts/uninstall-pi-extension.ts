#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PI_EXTENSION_FILE_NAME, uninstallPiExtension } from '../src/installers.js';
import { assertSupportedPlatform } from '../src/platform.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
  const settingsPath = process.env.PI_SETTINGS_FILE ?? join(homedir(), '.pi', 'agent', 'settings.json');
  const extensionsDir =
    process.env.PI_AGENT_PRESENCE_EXTENSION_DIR ?? join(homedir(), '.pi', 'agent', 'extensions');
  const extensionPath =
    process.env.PI_AGENT_PRESENCE_EXTENSION_FILE ?? join(extensionsDir, PI_EXTENSION_FILE_NAME);

  const result = await uninstallPiExtension({ extensionPath, settingsPath });

  if (result.status === 'removed') {
    console.log(`removed pi extension: ${result.extensionPath}`);
  } else {
    console.log(`skipped pi extension: ${result.extensionPath} (not managed by @rivus/agent-presence)`);
  }
  if (result.settingsUpdated) {
    console.log(`updated pi settings: ${result.settingsPath}`);
  } else if (result.settingsError) {
    console.warn(`warning: could not update pi settings at ${result.settingsPath}: ${result.settingsError}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
