import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readMagicToken } from '../src/magic-token.js';

// In-memory stand-in for the OS keyring so no test in this file touches the
// real Keychain or secret-tool. Entries are keyed by "<service>:<account>";
// seeding "agent-presence:magic-builder:token" pins both the keyring identity
// readMagicToken must use and the keyring step's place in the resolution order.
const keyring = vi.hoisted(() => {
  const entries = new Map<string, string>();
  return {
    entries,
    createGenericSecretStore: (service: string, account: string) => ({
      read: async () => entries.get(`${service}:${account}`),
      write: async (value: string) => {
        entries.set(`${service}:${account}`, value);
      },
      delete: async () => {
        entries.delete(`${service}:${account}`);
      }
    })
  };
});

vi.mock('../src/secret.js', () => ({ createGenericSecretStore: keyring.createGenericSecretStore }));

describe('readMagicToken', () => {
  let originalEnv: string | undefined;
  let originalHome: string | undefined;
  let workDir: string;
  let homeDir: string;

  beforeEach(async () => {
    keyring.entries.clear();
    originalEnv = process.env.MAGIC_TOKEN;
    originalHome = process.env.HOME;
    delete process.env.MAGIC_TOKEN;
    workDir = await mkdtemp(join(tmpdir(), 'agent-presence-magic-token-'));
    // Isolate HOME so the developer's real ~/.magic-token cannot leak into the
    // test (os.homedir() honors $HOME on POSIX). HOME does not isolate the
    // keyring; that step is covered by the module mock above.
    homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-magic-home-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.MAGIC_TOKEN;
    } else {
      process.env.MAGIC_TOKEN = originalEnv;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(workDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns undefined when no source is available', async () => {
    const result = await readMagicToken(workDir);
    expect(result.token).toBeUndefined();
    expect(result.source).toBeUndefined();
  });

  it('reads from the MAGIC_TOKEN env var first', async () => {
    process.env.MAGIC_TOKEN = 'env-token-value';
    const result = await readMagicToken(workDir);
    expect(result).toEqual({ token: 'env-token-value', source: 'env' });
  });

  it('reads the keyring before the token files, and env before the keyring', async () => {
    keyring.entries.set('agent-presence:magic-builder:token', 'keyring-token');
    await writeFile(join(homeDir, '.magic-token'), 'home-token\n');
    await writeFile(join(workDir, '.magic-token'), 'project-token\n');

    const fromKeyring = await readMagicToken(workDir);
    expect(fromKeyring).toEqual({ token: 'keyring-token', source: 'keychain' });

    process.env.MAGIC_TOKEN = 'env-token-value';
    const fromEnv = await readMagicToken(workDir);
    expect(fromEnv).toEqual({ token: 'env-token-value', source: 'env' });
  });

  it('reads project-local .magic-token when env and keyring are unset and trims whitespace', async () => {
    await writeFile(join(workDir, '.magic-token'), '  project-token  \n');
    const result = await readMagicToken(workDir);
    expect(result.token).toBe('project-token');
    expect(result.source).toBe('file');
    expect(result.path).toBe(join(workDir, '.magic-token'));
  });

  it('prefers a home-directory .magic-token over the project-local one', async () => {
    await writeFile(join(homeDir, '.magic-token'), 'home-token\n');
    await writeFile(join(workDir, '.magic-token'), 'project-token\n');
    const result = await readMagicToken(workDir);
    expect(result.token).toBe('home-token');
    expect(result.path).toBe(join(homeDir, '.magic-token'));
  });
});
