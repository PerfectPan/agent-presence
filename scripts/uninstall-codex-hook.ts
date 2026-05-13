#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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

function isAgentSignatureCommand(command: string): boolean {
  return command.includes('agent-presence hook') || command.includes('agent-signature hook') || command.includes('agent-signature.mjs hook');
}

async function loadHooks(path: string): Promise<HooksFile> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as HooksFile;
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
