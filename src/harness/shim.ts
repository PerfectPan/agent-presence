import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/mini';
import { getHomeDir } from '../config.js';
import { hasNodeErrorCode } from '../json-file.js';
import { packageVersion } from '../package-version.js';
import { shellQuote } from '../shell-quote.js';
import { presenceRuntimeCliPath } from './runtime.js';
import { presenceShimPath } from './shim-path.js';

export type HookCommandMode = 'package' | 'absolute';

export function resolveHookCommandMode(value = process.env.AGENT_PRESENCE_HOOK_COMMAND): HookCommandMode {
  const mode = z.optional(z.enum(['package', 'npx', 'absolute'])).parse(value);
  return mode === 'absolute' ? 'absolute' : 'package';
}

function resolvePresenceCliPath(): string {
  if (process.env.AGENT_PRESENCE_CLI_PATH) {
    return process.env.AGENT_PRESENCE_CLI_PATH;
  }
  for (const url of [new URL('../cli.js', import.meta.url), new URL('../../dist/src/cli.js', import.meta.url)]) {
    const resolved = fileURLToPath(url);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  throw new Error('unable to resolve @rivus/agent-presence CLI path');
}

interface PresenceShimOptions {
  mode?: HookCommandMode | 'npx';
  cliPath?: string;
  nodePath?: string;
  version?: string;
}

export async function readPresenceShimGeneration(home = getHomeDir()): Promise<string | undefined> {
  try {
    const contents = await readFile(presenceShimPath(home), 'utf8');
    const generation = /^# agent-presence shim-generation: (\S+)$/m.exec(contents)?.[1];
    return z.uuid().safeParse(generation).data;
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

export async function readPresenceShimRuntimeVersion(home = getHomeDir()): Promise<string | undefined> {
  let contents;
  try {
    contents = await readFile(presenceShimPath(home), 'utf8');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  const version = /^# agent-presence runtime-version: (\S+)$/m.exec(contents)?.[1];
  if (!version) {
    return undefined;
  }
  try {
    return contents.includes(` ${shellQuote(presenceRuntimeCliPath(version, home))} "$@"`) ? version : undefined;
  } catch {
    return undefined;
  }
}

export async function writePresenceShim(home = getHomeDir(), options: PresenceShimOptions = {}): Promise<string> {
  const shimPath = presenceShimPath(home);
  const mode = resolveHookCommandMode(options.mode ?? process.env.AGENT_PRESENCE_HOOK_COMMAND);
  const version = options.version ?? packageVersion();
  const cliPath =
    options.cliPath ?? (mode === 'absolute' ? resolvePresenceCliPath() : presenceRuntimeCliPath(version, home));
  const nodePath = options.nodePath ?? process.execPath;
  const runtimeMetadata = mode === 'package' ? `# agent-presence runtime-version: ${version}\n` : '';
  const contents = `#!/bin/sh\n# agent-presence shim-generation: ${randomUUID()}\n${runtimeMetadata}if [ -f ${shellQuote(nodePath)} ]; then\n  exec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"\nfi\nexec node ${shellQuote(cliPath)} "$@"\n`;
  await mkdir(dirname(shimPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${shimPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o755, flag: 'wx' });
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, shimPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return shimPath;
}

export async function removePresenceShim(home = getHomeDir()): Promise<void> {
  await rm(presenceShimPath(home), { force: true });
}
