#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PI_EXTENSION_FILE_NAME, installPiExtension } from '../src/installers.js';
import { assertSupportedPlatform } from '../src/platform.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
  const settingsPath = process.env.PI_SETTINGS_FILE ?? join(homedir(), '.pi', 'agent', 'settings.json');
  const extensionsDir =
    process.env.PI_AGENT_PRESENCE_EXTENSION_DIR ?? join(homedir(), '.pi', 'agent', 'extensions');
  const extensionPath =
    process.env.PI_AGENT_PRESENCE_EXTENSION_FILE ?? join(extensionsDir, PI_EXTENSION_FILE_NAME);

  const result = await installPiExtension({ extensionPath, settingsPath });

  console.log(`installed pi extension: ${result.extensionPath}`);
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
