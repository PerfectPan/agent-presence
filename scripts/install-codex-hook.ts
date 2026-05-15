#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentPresenceShellCommand,
  isAgentSignatureCommand,
  withTrustedCodexHookHashes
} from '../src/installers.js';
import { readJsonFile, writeJsonAtomic } from '../src/json-file.js';
import { assertSupportedPlatform } from '../src/platform.js';

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

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
  method?: string;
}

interface CodexHooksListResult {
  data?: Array<{
    hooks?: Array<{
      key?: unknown;
      command?: unknown;
      sourcePath?: unknown;
      currentHash?: unknown;
    }>;
  }>;
}

async function main(): Promise<void> {
  assertSupportedPlatform();
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
          command: `${buildAgentPresenceShellCommand(['hook', '--source', 'codex', '--event', event])} 2>/dev/null || echo '{}'`,
          timeout: 5000
        }
      ]
    });
  }

  await writeJsonAtomic(hooksPath, doc);
  const trustedCount = await trustInstalledHooks(hooksPath);
  console.log(`installed codex hooks: ${hooksPath}`);
  if (trustedCount > 0) {
    console.log(`trusted codex hooks: ${trustedCount}`);
  }
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

async function loadHooks(path: string): Promise<HooksFile> {
  return readJsonFile<HooksFile>(path, { hooks: {} });
}

async function trustInstalledHooks(hooksPath: string): Promise<number> {
  if (process.env.AGENT_PRESENCE_TRUST_CODEX_HOOKS === '0' || process.env.CODEX_HOOKS_FILE) {
    return 0;
  }

  const codexCli = resolveCodexCli();
  if (!codexCli) {
    return 0;
  }

  try {
    const result = await listCodexHooks(codexCli);
    const entries = extractTrustedEntries(result, hooksPath);
    if (entries.length === 0) {
      return 0;
    }
    const configPath = process.env.CODEX_CONFIG_FILE ?? join(homedir(), '.codex', 'config.toml');
    const next = withTrustedCodexHookHashes(readFileSync(configPath, 'utf8'), entries);
    writeFileSync(configPath, next, 'utf8');
    return entries.length;
  } catch {
    return 0;
  }
}

function resolveCodexCli(): string | undefined {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    '/Applications/Codex.app/Contents/Resources/codex',
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex'
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

async function listCodexHooks(codexCli: string): Promise<CodexHooksListResult> {
  const client = new JsonRpcClient(codexCli, ['app-server', '--listen', 'stdio://']);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'agent-presence', version: '0.0.0' },
      capabilities: { experimentalApi: true }
    });
    client.notify('initialized', {});
    return (await client.request('hooks/list', {})) as CodexHooksListResult;
  } finally {
    client.close();
  }
}

function extractTrustedEntries(result: CodexHooksListResult, hooksPath: string): Array<{ key: string; trustedHash: string }> {
  return (result.data ?? [])
    .flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.sourcePath === hooksPath)
    .filter((hook) => typeof hook.command === 'string' && isAgentSignatureCommand(hook.command))
    .flatMap((hook) =>
      typeof hook.key === 'string' && typeof hook.currentHash === 'string'
        ? [{ key: hook.key, trustedHash: hook.currentHash }]
        : []
    );
}

class JsonRpcClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();
  private readonly child: ReturnType<typeof spawn>;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    if (!this.child.stdout || !this.child.stdin) {
      throw new Error('failed to start codex app-server');
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, 5000);
      this.pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
        } else {
          resolve(message.result);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.child.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (typeof message.id === 'number') {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    }
  }

  private write(message: unknown): void {
    if (!this.child.stdin) {
      throw new Error('codex app-server stdin is closed');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
