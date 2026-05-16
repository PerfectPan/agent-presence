import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCredential, writeCredential, deleteCredential } from '../src/secret.js';

const execFileAsync = promisify(execFile);

const macOs = process.platform === 'darwin';
const linux = process.platform === 'linux';

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
      await writeCredential({ token: testToken, slotId: testSlotId });

      const cred = await readCredential();
      expect(cred).toEqual({ token: testToken, slotId: testSlotId });

      await deleteCredential();

      const after = await readCredential();
      expect(after).toBeUndefined();
    });
  });

  describe('Linux libsecret backend', () => {
    it('writes, reads, and deletes credentials from secret-tool', async () => {
      if (!linux) return;
      if (process.env.CI && !(await secretToolFunctional())) {
        console.warn('secret-tool is not functional (no keyring daemon in CI); skipping integration test');
        return;
      }

      await writeCredential({ token: testToken, slotId: testSlotId });

      const cred = await readCredential();
      expect(cred).toEqual({ token: testToken, slotId: testSlotId });

      await deleteCredential();

      const after = await readCredential();
      expect(after).toBeUndefined();
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
