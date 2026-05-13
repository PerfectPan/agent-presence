#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { buildOpenCodePluginSource, withOpenCodeAgentSignaturePluginConfig, type OpenCodeConfig } from '../src/installers.js';
import { readJsonFile, writeJsonAtomic } from '../src/json-file.js';
import { assertSupportedPlatform } from '../src/platform.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
  const configPath = process.env.OPENCODE_CONFIG ?? join(homedir(), '.config', 'opencode', 'opencode.json');
  const pluginPath =
    process.env.OPENCODE_AGENT_PRESENCE_PLUGIN_FILE ??
    process.env.OPENCODE_AGENT_SIGNATURE_PLUGIN_FILE ??
    join(dirname(configPath), 'plugins', 'agent-presence.js');
  await mkdir(dirname(pluginPath), { recursive: true, mode: 0o700 });
  await writeFile(pluginPath, buildOpenCodePluginSource(), { mode: 0o600 });
  await writeJsonAtomic(configPath, withOpenCodeAgentSignaturePluginConfig(await loadConfig(configPath)));
  console.log(`installed opencode plugin: ${pluginPath}`);
  console.log(`updated opencode config: ${configPath}`);
}

async function loadConfig(path: string): Promise<OpenCodeConfig> {
  return readJsonFile<OpenCodeConfig>(path, {});
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
