import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hasNodeErrorCode } from './json-file.js';
import { createGenericSecretStore } from './secret.js';

export const MAGIC_TOKEN_FILE_NAME = '.magic-token';
export const MAGIC_TOKEN_KEYCHAIN_SERVICE = 'agent-presence:magic-builder';
export const MAGIC_TOKEN_KEYCHAIN_ACCOUNT = 'token';

/**
 * File search order matches the magic-builder skill pack so a token a user
 * already saved there keeps working:
 *   ~/.magic-token -> <cwd>/.magic-token
 *
 * Skill-pack-relative paths are intentionally not searched: agent-presence
 * does not ship a skill directory of its own.
 */
export function getMagicTokenSearchPaths(cwd: string = process.cwd()): string[] {
  return [join(homedir(), MAGIC_TOKEN_FILE_NAME), join(cwd, MAGIC_TOKEN_FILE_NAME)];
}

export type MagicTokenSource = 'env' | 'keychain' | 'file';

export interface ReadMagicTokenResult {
  token?: string;
  source?: MagicTokenSource;
  path?: string;
}

function tokenStore() {
  return createGenericSecretStore(MAGIC_TOKEN_KEYCHAIN_SERVICE, MAGIC_TOKEN_KEYCHAIN_ACCOUNT);
}

/**
 * Resolution order:
 *   MAGIC_TOKEN env -> OS keyring (keychain/libsecret) -> ~/.magic-token -> <cwd>/.magic-token
 *
 * Env wins for one-off overrides; the keyring is where `writeMagicToken`
 * persists interactively-entered tokens; the plaintext files are read for
 * backward/skill-pack compatibility but are never written by this CLI.
 */
export async function readMagicToken(cwd: string = process.cwd()): Promise<ReadMagicTokenResult> {
  const envValue = process.env.MAGIC_TOKEN?.trim();
  if (envValue) {
    return { token: envValue, source: 'env' };
  }

  const fromKeyring = (await tokenStore().read())?.trim();
  if (fromKeyring) {
    return { token: fromKeyring, source: 'keychain' };
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

/** Persist a token to the OS keyring (Keychain on macOS, libsecret on Linux). */
export async function writeMagicToken(token: string): Promise<void> {
  await tokenStore().write(token.trim());
}

export async function deleteMagicToken(): Promise<void> {
  await tokenStore().delete();
}
