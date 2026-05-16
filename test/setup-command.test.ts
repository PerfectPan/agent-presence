import { beforeEach, describe, expect, it, vi } from 'vitest';

const hasCredentialMock = vi.hoisted(() => vi.fn());
const loginMock = vi.hoisted(() => vi.fn());
const runSetupScriptsMock = vi.hoisted(() => vi.fn());
const readCredentialMock = vi.hoisted(() => vi.fn());

vi.mock('../src/cli/credential.js', () => ({
  hasCredential: hasCredentialMock
}));

vi.mock('../src/cli/commands/login.js', () => ({
  login: loginMock
}));

vi.mock('../src/setup.js', () => ({
  LINUX_WATCHER_SKIP_MESSAGE: 'linux watcher skipped',
  runSetupScripts: runSetupScriptsMock
}));

vi.mock('../src/secret.js', () => ({
  readCredential: readCredentialMock
}));

vi.mock('../src/config.js', () => ({
  configSlotId: () => 'slot_config',
  loadConfig: vi.fn().mockResolvedValue({ provider: 'feishu-signature', slot_id: 'slot_config' }),
  providerId: (_config: unknown, provider?: string) => provider ?? 'feishu-signature'
}));

vi.mock('../src/migration.js', () => ({
  cleanupMigratedLegacyHome: vi.fn().mockResolvedValue(undefined),
  hasLegacyHomeToMigrate: vi.fn().mockResolvedValue(false),
  migrateLegacyHome: vi.fn()
}));

vi.mock('../src/platform.js', () => ({
  isMacOS: vi.fn().mockReturnValue(true)
}));

vi.mock('../src/cli/ui.js', () => ({
  createSpinner: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    error: vi.fn()
  }),
  finishOutro: vi.fn(),
  promptConfirm: vi.fn(),
  showInfo: vi.fn(),
  showNote: vi.fn(),
  startIntro: vi.fn()
}));

vi.mock('../src/cli/commands/url.js', () => ({
  resolveSignatureUrl: vi.fn().mockResolvedValue('https://l.garyyang.work/?t2=test')
}));

describe('setup command login behavior', () => {
  let setup: typeof import('../src/cli/commands/setup.js').setup;

  beforeEach(async () => {
    vi.clearAllMocks();
    hasCredentialMock.mockResolvedValue(true);
    loginMock.mockResolvedValue(undefined);
    runSetupScriptsMock.mockResolvedValue([]);
    readCredentialMock.mockResolvedValue({ token: 'token', slotId: 'slot_config' });
    ({ setup } = await import('../src/cli/commands/setup.js'));
  });

  it('reuses existing credentials without starting login', async () => {
    hasCredentialMock.mockResolvedValue(true);

    await setup(['--provider', 'feishu-signature', '--no-hooks']);

    expect(hasCredentialMock).toHaveBeenCalledTimes(1);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('starts login when credentials are missing', async () => {
    hasCredentialMock.mockResolvedValue(false);
    readCredentialMock.mockResolvedValue(undefined);

    await setup(['--provider', 'feishu-signature', '--no-hooks']);

    expect(loginMock).toHaveBeenCalledWith(['--provider', 'feishu-signature']);
  });

  it('does not start login when skip-login is set', async () => {
    hasCredentialMock.mockResolvedValue(false);

    await setup(['--provider', 'feishu-signature', '--no-hooks', '--skip-login']);

    expect(hasCredentialMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('forces login when login is set even if credentials exist', async () => {
    hasCredentialMock.mockResolvedValue(true);

    await setup(['--provider', 'feishu-signature', '--no-hooks', '--login']);

    expect(loginMock).toHaveBeenCalledWith(['--provider', 'feishu-signature']);
  });
});
