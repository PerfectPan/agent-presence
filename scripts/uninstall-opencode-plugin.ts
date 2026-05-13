#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withoutOpenCodeAgentSignaturePluginConfig, type OpenCodeConfig } from '../src/installers.js';

async function main(): Promise<void> {
  const configPath = process.env.OPENCODE_CONFIG ?? join(homedir(), '.config', 'opencode', 'opencode.json');
  const pluginPath =
    process.env.OPENCODE_AGENT_PRESENCE_PLUGIN_FILE ??
    process.env.OPENCODE_AGENT_SIGNATURE_PLUGIN_FILE ??
    join(dirname(configPath), 'plugins', 'agent-presence.js');
  const legacyPluginPath = join(dirname(configPath), 'plugins', 'agent-signature.js');
  await rm(pluginPath, { force: true });
  await rm(legacyPluginPath, { force: true });
  await writeJsonAtomic(configPath, withoutOpenCodeAgentSignaturePluginConfig(await loadConfig(configPath)));
  console.log(`removed opencode plugin: ${pluginPath}`);
  console.log(`updated opencode config: ${configPath}`);
}

async function loadConfig(path: string): Promise<OpenCodeConfig> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as OpenCodeConfig;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return {};
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
