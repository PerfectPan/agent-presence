import { describe, expect, it } from 'vitest';
import { readCredential, writeCredential, deleteCredential } from '../src/secret.js';

const macOs = process.platform === 'darwin';
const linux = process.platform === 'linux';

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
    const test = linux ? it : it.skip;

    test('writes, reads, and deletes credentials from secret-tool', async () => {
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
