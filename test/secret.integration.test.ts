import { describe, expect, it } from 'vite-plus/test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCredentialStore, readCredential, type CredentialStore } from '../src/secret.js';

const execFileAsync = promisify(execFile);

const macOs = process.platform === 'darwin';
const linux = process.platform === 'linux';
// The libsecret case talks to the developer's real keyring, so it only runs on
// explicit opt-in. The macOS case never touches the login keychain: it uses a
// dedicated temporary keychain file, so it is safe to run everywhere.
const secretIntegration = process.env.PRESENCE_SECRET_INTEGRATION === '1';

const credentialEnvKeys = [
  'AGENT_PRESENCE_L_GARYYANG_TOKEN',
  'AGENT_PRESENCE_TOKEN',
  'AGENT_SIGNATURE_L_GARYYANG_TOKEN',
  'AGENT_SIGNATURE_TOKEN',
  'FEISHU_SLOT_CREDENTIAL',
  'AGENT_PRESENCE_L_GARYYANG_SLOT_ID',
  'AGENT_PRESENCE_SLOT_ID',
  'AGENT_SIGNATURE_L_GARYYANG_SLOT_ID',
  'AGENT_SIGNATURE_SLOT_ID'
];

async function hasSecretTool(): Promise<boolean> {
  try {
    await execFileAsync('secret-tool', ['--version']);
    return true;
  } catch {
    return false;
  }
}

function saveCredentialEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of credentialEnvKeys) {
    saved[key] = process.env[key];
  }
  return saved;
}

function clearCredentialEnv(): void {
  for (const key of credentialEnvKeys) {
    delete process.env[key];
  }
}

function restoreCredentialEnv(saved: Record<string, string | undefined>): void {
  for (const key of credentialEnvKeys) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

function uniqueSuffix(): string {
  return `${process.pid}-${randomBytes(8).toString('hex')}`;
}

async function cleanupLibsecretService(libsecretService: string): Promise<void> {
  if (linux && (await hasSecretTool())) {
    await Promise.all([
      execFileAsync('secret-tool', ['clear', 'service', libsecretService, 'account', 'token']).catch(() => undefined),
      execFileAsync('secret-tool', ['clear', 'service', libsecretService, 'account', 'slotId']).catch(() => undefined)
    ]);
  }
}

async function withIsolatedCredentialStore(run: (store: CredentialStore) => Promise<void>): Promise<void> {
  const savedEnv = saveCredentialEnv();
  const libsecretService = `agent-presence-test-${uniqueSuffix()}`;

  clearCredentialEnv();
  const store = createCredentialStore({ libsecretService });

  try {
    await run(store);
  } finally {
    await cleanupLibsecretService(libsecretService);
    restoreCredentialEnv(savedEnv);
  }
}

describe('credential storage integration', () => {
  // The macOS case runs against a throwaway keychain file created per run, so
  // fixed values cannot collide with anything.
  const testToken = 'integration-test-token';
  const testSlotId = 'integration-test-slot';
  const updatedToken = 'integration-test-token-updated';
  const updatedSlotId = 'integration-test-slot-updated';

  describe('macOS Keychain backend', () => {
    it.skipIf(!macOs)('writes, reads, updates, and deletes credentials in a temporary keychain', async () => {
      const savedEnv = saveCredentialEnv();
      const dir = await mkdtemp(join(tmpdir(), 'agent-presence-keychain-'));
      const keychainPath = join(dir, 'test.keychain');
      const keychainPassword = randomBytes(24).toString('hex');
      const keychainService = `agent-presence-test:${uniqueSuffix()}`;
      const keychainLegacyService = `agent-presence-test-legacy:${uniqueSuffix()}`;

      try {
        clearCredentialEnv();
        await execFileAsync('security', ['create-keychain', '-p', keychainPassword, keychainPath]);
        await execFileAsync('security', ['unlock-keychain', '-p', keychainPassword, keychainPath]);
        await execFileAsync('security', ['set-keychain-settings', keychainPath]);

        const store = createCredentialStore({ keychainService, keychainLegacyService, keychainPath });

        await store.writeCredential({ token: testToken, slotId: testSlotId });
        const cred = await store.readCredential();
        expect(cred).toEqual({ token: testToken, slotId: testSlotId });

        await store.writeCredential({ token: updatedToken, slotId: updatedSlotId });
        const updated = await store.readCredential();
        expect(updated).toEqual({ token: updatedToken, slotId: updatedSlotId });

        await store.deleteCredential();
        const after = await store.readCredential();
        expect(after).toBeUndefined();
      } finally {
        await execFileAsync('security', ['delete-keychain', keychainPath]).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
        restoreCredentialEnv(savedEnv);
      }
    });
  });

  describe('Linux libsecret backend', () => {
    it('writes, reads, and deletes credentials from secret-tool', async (ctx) => {
      ctx.skip(!linux, 'linux only');
      ctx.skip(!secretIntegration, 'set PRESENCE_SECRET_INTEGRATION=1 to run against the real keyring');

      await withIsolatedCredentialStore(async (store) => {
        await store.writeCredential({ token: testToken, slotId: testSlotId });

        const cred = await store.readCredential();
        expect(cred).toEqual({ token: testToken, slotId: testSlotId });

        await store.deleteCredential();

        const after = await store.readCredential();
        expect(after).toBeUndefined();
      });
    });
  });

  describe('environment variable priority', () => {
    const savedToken = process.env.AGENT_PRESENCE_TOKEN;
    const savedSlotId = process.env.AGENT_PRESENCE_SLOT_ID;

    it.skipIf(!macOs && !linux)('env vars override backend storage', async () => {
      process.env.AGENT_PRESENCE_TOKEN = 'env-override-tok';
      process.env.AGENT_PRESENCE_SLOT_ID = 'env-override-sid';

      try {
        const cred = await readCredential();
        expect(cred).toEqual({ token: 'env-override-tok', slotId: 'env-override-sid' });
      } finally {
        if (savedToken !== undefined) {
          process.env.AGENT_PRESENCE_TOKEN = savedToken;
        } else {
          delete process.env.AGENT_PRESENCE_TOKEN;
        }
        if (savedSlotId !== undefined) {
          process.env.AGENT_PRESENCE_SLOT_ID = savedSlotId;
        } else {
          delete process.env.AGENT_PRESENCE_SLOT_ID;
        }
      }
    });
  });
});
