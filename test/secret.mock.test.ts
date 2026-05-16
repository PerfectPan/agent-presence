import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}));

describe('credential storage', () => {
  let readCredential: typeof import('../src/secret.js').readCredential;
  let writeCredential: typeof import('../src/secret.js').writeCredential;
  let deleteCredential: typeof import('../src/secret.js').deleteCredential;

  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
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

  beforeEach(async () => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    execFileMock.mockReset();

    const mod = await import('../src/secret.js');
    readCredential = mod.readCredential;
    writeCredential = mod.writeCredential;
    deleteCredential = mod.deleteCredential;
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    vi.resetModules();
  });

  const originalPlatform = process.platform;

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  function cbResolve(value: string): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: value });
    };
  }

  function cbReject(msg: string): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(new Error(msg));
    };
  }

  function cbIgnore(...args: unknown[]) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(null, { stdout: '' });
  }

  describe('environment variable resolution (platform-independent)', () => {
    it('reads token and slotId from AGENT_PRESENCE_L_GARYYANG_* env vars', async () => {
      process.env.AGENT_PRESENCE_L_GARYYANG_TOKEN = 'env-token';
      process.env.AGENT_PRESENCE_L_GARYYANG_SLOT_ID = 'env-slot';

      const cred = await readCredential();
      expect(cred).toEqual({ token: 'env-token', slotId: 'env-slot' });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('reads token from AGENT_PRESENCE_TOKEN and slotId from AGENT_PRESENCE_SLOT_ID', async () => {
      process.env.AGENT_PRESENCE_TOKEN = 'pt';
      process.env.AGENT_PRESENCE_SLOT_ID = 'ps';

      const cred = await readCredential();
      expect(cred).toEqual({ token: 'pt', slotId: 'ps' });
    });

    it('reads token from FEISHU_SLOT_CREDENTIAL (legacy env)', async () => {
      process.env.FEISHU_SLOT_CREDENTIAL = 'legacy-token';
      process.env.AGENT_PRESENCE_SLOT_ID = 'ps';

      const cred = await readCredential();
      expect(cred).toEqual({ token: 'legacy-token', slotId: 'ps' });
    });
  });

  describe('Linux secret-tool backend', () => {
    beforeEach(() => setPlatform('linux'));

    it('throws when secret-tool is not available and no env vars are set', async () => {
      execFileMock.mockImplementation(cbReject('ENOENT'));

      await expect(readCredential()).rejects.toThrow(
        'agent-presence requires libsecret on linux (install gnome-keyring or libsecret-tools)'
      );
    });

    it('reads credentials from secret-tool when env vars are not set', async () => {
      execFileMock
        .mockImplementationOnce(cbResolve('1.0'))
        .mockImplementationOnce(cbResolve('st-token\n'))
        .mockImplementationOnce(cbResolve('1.0'))
        .mockImplementationOnce(cbResolve('st-slot\n'));

      const cred = await readCredential();
      expect(cred).toEqual({ token: 'st-token', slotId: 'st-slot' });
    });

    it('skips secret-tool when env vars provide everything', async () => {
      process.env.AGENT_PRESENCE_TOKEN = 'env-tok';
      process.env.AGENT_PRESENCE_SLOT_ID = 'env-sid';

      const cred = await readCredential();
      expect(cred).toEqual({ token: 'env-tok', slotId: 'env-sid' });
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns undefined when secret-tool has no stored credential', async () => {
      execFileMock
        .mockImplementationOnce(cbResolve('1.0'))
        .mockImplementationOnce(cbReject('not found'))
        .mockImplementationOnce(cbResolve('1.0'))
        .mockImplementationOnce(cbReject('not found'));

      const cred = await readCredential();
      expect(cred).toBeUndefined();
    });

    it('writeCredential stores via secret-tool on Linux', async () => {
      execFileMock.mockImplementation(cbIgnore);

      await writeCredential({ token: 'my-token', slotId: 'my-slot' });

      // ensureSecretTool + 2 store calls (each with callback from promisify)
      expect(execFileMock).toHaveBeenCalledTimes(3);
      const calls = execFileMock.mock.calls;
      expect(calls[0]![0]).toBe('secret-tool');
      expect(calls[0]![1]).toEqual(['--version']);
      expect(calls[1]![0]).toBe('secret-tool');
      expect(calls[1]![1]).toEqual(['store', '--label', 'agent-presence', 'service', 'agent-presence', 'account', 'token']);
      expect(calls[1]![2]).toEqual({ input: 'my-token' });
      expect(calls[2]![0]).toBe('secret-tool');
      expect(calls[2]![1]).toEqual(['store', '--label', 'agent-presence', 'service', 'agent-presence', 'account', 'slotId']);
      expect(calls[2]![2]).toEqual({ input: 'my-slot' });
    });

    it('writeCredential throws when secret-tool is missing on Linux', async () => {
      execFileMock.mockImplementation(cbReject('ENOENT'));

      await expect(writeCredential({ token: 't', slotId: 's' })).rejects.toThrow('libsecret');
    });

    it('deleteCredential clears via secret-tool on Linux', async () => {
      execFileMock.mockImplementation(cbIgnore);

      await deleteCredential();

      // ensureSecretTool + 2 clear calls
      expect(execFileMock).toHaveBeenCalledTimes(3);
      const calls = execFileMock.mock.calls;
      expect(calls[0]![0]).toBe('secret-tool');
      expect(calls[0]![1]).toEqual(['--version']);
      expect(calls[1]![0]).toBe('secret-tool');
      expect(calls[1]![1]).toEqual(['clear', 'service', 'agent-presence', 'account', 'token']);
      expect(calls[2]![0]).toBe('secret-tool');
      expect(calls[2]![1]).toEqual(['clear', 'service', 'agent-presence', 'account', 'slotId']);
    });

    it('deleteCredential throws when secret-tool is missing on Linux', async () => {
      execFileMock.mockImplementation(cbReject('ENOENT'));

      await expect(deleteCredential()).rejects.toThrow('libsecret');
    });

    it('uses configSlotId fallback when env token is set but no env slotId and secret-tool has no slotId', async () => {
      process.env.AGENT_PRESENCE_TOKEN = 'env-tok';

      execFileMock
        .mockImplementationOnce(cbResolve('1.0'))
        .mockImplementationOnce(cbReject('not found'));

      const cred = await readCredential('config-slot');
      expect(cred).toEqual({ token: 'env-tok', slotId: 'config-slot' });
    });

    it('bails when no env token and secret-tool is unavailable', async () => {
      execFileMock.mockImplementation(cbReject('ENOENT'));

      await expect(readCredential('config-slot')).rejects.toThrow(
        'agent-presence requires libsecret on linux (install gnome-keyring or libsecret-tools)'
      );
    });
  });

  describe('macOS Keychain backend (preserved behavior)', () => {
    beforeEach(() => setPlatform('darwin'));

    it('reads from Keychain when env vars are not set', async () => {
      execFileMock.mockImplementation(cbResolve('kc-value\n'));

      const cred = await readCredential();
      expect(cred).toEqual({ token: 'kc-value', slotId: 'kc-value' });
    });

    it('returns undefined when Keychain has no entry', async () => {
      execFileMock.mockImplementation(cbReject('not found'));

      const cred = await readCredential();
      expect(cred).toBeUndefined();
    });

    it('writeCredential stores via security CLI on macOS', async () => {
      execFileMock.mockImplementation(cbIgnore);

      await writeCredential({ token: 'mytok', slotId: 'myslot' });

      expect(execFileMock).toHaveBeenCalledTimes(2);
      const calls = execFileMock.mock.calls;
      expect(calls[0]![0]).toBe('security');
      expect(calls[0]![1]).toEqual(['add-generic-password', '-U', '-s', 'agent-signature:l-garyyang', '-a', 'token', '-w', 'mytok']);
      expect(calls[1]![0]).toBe('security');
      expect(calls[1]![1]).toEqual(['add-generic-password', '-U', '-s', 'agent-signature:l-garyyang', '-a', 'slotId', '-w', 'myslot']);
    });

    it('deleteCredential clears via security CLI on macOS', async () => {
      execFileMock.mockImplementation(cbIgnore);

      await deleteCredential();

      // delete SERVICE token + SERVICE slotId + LEGACY_SERVICE
      expect(execFileMock).toHaveBeenCalledTimes(3);
      const calls = execFileMock.mock.calls;
      expect(calls[0]![0]).toBe('security');
      expect(calls[0]![1]).toEqual(['delete-generic-password', '-s', 'agent-signature:l-garyyang', '-a', 'token']);
      expect(calls[1]![0]).toBe('security');
      expect(calls[1]![1]).toEqual(['delete-generic-password', '-s', 'agent-signature:l-garyyang', '-a', 'slotId']);
      // legacy keychain entry
      expect(calls[2]![0]).toBe('security');
    });
  });
});
