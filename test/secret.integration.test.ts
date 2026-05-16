import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCredentialStore, readCredential, type CredentialStore } from '../src/secret.js';

const execFileAsync = promisify(execFile);

const macOs = process.platform === 'darwin';
const linux = process.platform === 'linux';
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

async function secretToolFunctional(): Promise<boolean> {
  if (!(await hasSecretTool())) return false;
  const probeValue = 'ap-probe-' + Date.now();
  try {
    await execFileAsync('secret-tool', ['store', '--label', 'agent-presence', 'service', 'agent-presence-ci', 'account', 'probe'], { input: probeValue } as any);
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', 'agent-presence-ci', 'account', 'probe'], { encoding: 'utf8' });
    await execFileAsync('secret-tool', ['clear', 'service', 'agent-presence-ci', 'account', 'probe']);
    return stdout.trim() === probeValue;
  } catch {
    return false;
  }
}

describe('credential storage integration', () => {
  const testToken = 'integration-test-token-' + Date.now();
  const testSlotId = 'integration-test-slot-' + Date.now();

  describe('macOS Keychain backend', () => {
    const test = macOs ? it : it.skip;

    test('writes, reads, and deletes credentials from Keychain', async () => {
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

  describe('Linux libsecret backend', () => {
    it('writes, reads, and deletes credentials from secret-tool', async () => {
      if (!linux) return;
      if (process.env.CI && !(await secretToolFunctional())) {
        console.warn('secret-tool is not functional (no keyring daemon in CI); skipping integration test');
        return;
      }

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
    const test = macOs || linux ? it : it.skip;

    const savedToken = process.env.AGENT_PRESENCE_TOKEN;
    const savedSlotId = process.env.AGENT_PRESENCE_SLOT_ID;

    test('env vars override backend storage', async () => {
      process.env.AGENT_PRESENCE_TOKEN = 'env-override-tok';
      process.env.AGENT_PRESENCE_SLOT_ID = 'env-override-sid';

      try {
        const cred = await readCredential();
        expect(cred).toEqual({ token: 'env-override-tok', slotId: 'env-override-sid' });
      } finally {
        if (savedToken !== undefined) process.env.AGENT_PRESENCE_TOKEN = savedToken;
        else delete process.env.AGENT_PRESENCE_TOKEN;
        if (savedSlotId !== undefined) process.env.AGENT_PRESENCE_SLOT_ID = savedSlotId;
        else delete process.env.AGENT_PRESENCE_SLOT_ID;
      }
    });
  });
});

async function withIsolatedCredentialStore(run: (store: CredentialStore) => Promise<void>): Promise<void> {
  const savedEnv = saveCredentialEnv();
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const keychainService = `agent-presence-test:${suffix}`;
  const keychainLegacyService = `agent-presence-test-legacy:${suffix}`;
  const libsecretService = `agent-presence-test-${suffix}`;

  clearCredentialEnv();
  const store = createCredentialStore({
    keychainService,
    keychainLegacyService,
    libsecretService
  });

  try {
    await run(store);
  } finally {
    await cleanupIsolatedStores(keychainService, keychainLegacyService, libsecretService);
    restoreCredentialEnv(savedEnv);
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

async function cleanupIsolatedStores(
  keychainService: string,
  keychainLegacyService: string,
  libsecretService: string
): Promise<void> {
  if (macOs) {
    await Promise.all([
      deleteKeychain(keychainService, 'token'),
      deleteKeychain(keychainService, 'slotId'),
      deleteKeychain(keychainLegacyService, process.env.USER ?? 'agent-presence')
    ]);
  }

  if (linux && (await hasSecretTool())) {
    await Promise.all([
      execFileAsync('secret-tool', ['clear', 'service', libsecretService, 'account', 'token']).catch(() => undefined),
      execFileAsync('secret-tool', ['clear', 'service', libsecretService, 'account', 'slotId']).catch(() => undefined)
    ]);
  }
}

async function deleteKeychain(service: string, account: string): Promise<void> {
  await execFileAsync('security', ['delete-generic-password', '-s', service, '-a', account]).catch(() => undefined);
}
