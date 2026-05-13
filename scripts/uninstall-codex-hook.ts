#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isAgentSignatureCommand } from '../src/installers.js';
import { readJsonFile, writeJsonAtomic } from '../src/json-file.js';
import { assertSupportedPlatform } from '../src/platform.js';

interface HookCommand {
  command: string;
}

interface HookGroup {
  hooks?: HookCommand[];
}

interface HooksFile {
  hooks?: Record<string, HookGroup[]>;
}

async function main(): Promise<void> {
  assertSupportedPlatform();
  const hooksPath = process.env.CODEX_HOOKS_FILE ?? join(homedir(), '.codex', 'hooks.json');
  const doc = await loadHooks(hooksPath);
  doc.hooks ??= {};

  for (const event of Object.keys(doc.hooks)) {
    doc.hooks[event] = doc.hooks[event].flatMap((group) => {
      const hooks = (group.hooks ?? []).filter((hook) => !isAgentSignatureCommand(hook.command));
      return hooks.length > 0 ? [{ ...group, hooks }] : [];
    });
    if (doc.hooks[event].length === 0) {
      delete doc.hooks[event];
    }
  }

  await writeJsonAtomic(hooksPath, doc);
  console.log(`removed agent-presence codex hooks: ${hooksPath}`);
}

async function loadHooks(path: string): Promise<HooksFile> {
  return readJsonFile<HooksFile>(path, { hooks: {} });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
