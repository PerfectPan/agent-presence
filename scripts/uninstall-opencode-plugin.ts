#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withoutOpenCodeAgentSignaturePluginConfig, type OpenCodeConfig } from '../src/installers.js';
import { readJsonFile, writeJsonAtomic } from '../src/json-file.js';
import { assertSupportedPlatform } from '../src/platform.js';

async function main(): Promise<void> {
  assertSupportedPlatform();
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
  return readJsonFile<OpenCodeConfig>(path, {});
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
