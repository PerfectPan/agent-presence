#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
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

  for (const event of EVENTS) {
    const groups = doc.hooks[event] ?? [];
    doc.hooks[event] = withoutAgentSignatureHooks(groups);
    doc.hooks[event].push({
      hooks: [
        {
          type: 'command',
          command: `agent-presence hook --source codex --event ${event} 2>/dev/null || echo '{}'`,
          timeout: 5000
        }
      ]
    });
  }

  await writeJsonAtomic(hooksPath, doc);
  console.log(`installed codex hooks: ${hooksPath}`);
}

function withoutAgentSignatureHooks(groups: HookGroup[]): HookGroup[] {
  const next: HookGroup[] = [];
  for (const group of groups) {
    const hooks = (group.hooks ?? []).filter((hook) => !isAgentSignatureCommand(hook.command));
    if (hooks.length > 0) {
      next.push({ ...group, hooks });
    }
  }
  return next;
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
