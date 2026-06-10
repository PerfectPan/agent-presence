import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { hasNodeErrorCode } from './json-file.js';

export const MAGIC_TOKEN_FILE_NAME = '.magic-token';

/**
 * Resolution order matches the magic-builder skill pack:
 *   MAGIC_TOKEN env -> ~/.magic-token -> <cwd>/.magic-token
 *
 * Skill-pack-relative paths are intentionally not searched: agent-presence
 * does not ship a skill directory of its own.
 */
export function getMagicTokenSearchPaths(cwd: string = process.cwd()): string[] {
  return [join(homedir(), MAGIC_TOKEN_FILE_NAME), join(cwd, MAGIC_TOKEN_FILE_NAME)];
}

export interface ReadMagicTokenResult {
  token?: string;
  source?: 'env' | 'file';
  path?: string;
}

export async function readMagicToken(cwd: string = process.cwd()): Promise<ReadMagicTokenResult> {
  const envValue = process.env.MAGIC_TOKEN?.trim();
  if (envValue) {
    return { token: envValue, source: 'env' };
  }

  for (const path of getMagicTokenSearchPaths(cwd)) {
    try {
      const contents = (await readFile(path, 'utf8')).trim();
      if (contents) {
        return { token: contents, source: 'file', path };
      }
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  return {};
}

export async function writeMagicToken(token: string): Promise<string> {
  const target = join(homedir(), MAGIC_TOKEN_FILE_NAME);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${token.trim()}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}
