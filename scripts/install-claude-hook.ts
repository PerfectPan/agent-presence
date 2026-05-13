#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withClaudeAgentSignatureHooks, type HookSettings } from '../src/installers.js';

async function main(): Promise<void> {
  const settingsPath = process.env.CLAUDE_SETTINGS_FILE ?? join(homedir(), '.claude', 'settings.json');
  const settings = await loadSettings(settingsPath);
  await writeJsonAtomic(settingsPath, withClaudeAgentSignatureHooks(settings));
  console.log(`installed claude hooks: ${settingsPath}`);
}

async function loadSettings(path: string): Promise<Partial<HookSettings>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Partial<HookSettings>;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { hooks: {} };
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, path);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
