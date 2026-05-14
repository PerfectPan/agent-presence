#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { withoutAgentSignatureHooks, type HookSettings } from '../src/installers.js';
import { readJsonFile, writeJsonAtomic } from '../src/json-file.js';
import { assertSupportedPlatform } from '../src/platform.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
  const settingsPath = process.env.GEMINI_SETTINGS_FILE || join(homedir(), '.gemini', 'settings.json');
  const settings = await loadSettings(settingsPath);
  await writeJsonAtomic(settingsPath, withoutAgentSignatureHooks(settings));
  console.log('removed agent-presence gemini hooks: ' + settingsPath);
}

async function loadSettings(path: string): Promise<Partial<HookSettings>> {
  return readJsonFile(path, { hooks: {} });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
