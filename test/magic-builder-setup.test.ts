import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMagicToken = vi.hoisted(() => vi.fn());
const writeMagicToken = vi.hoisted(() => vi.fn());
const readCredential = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
const saveConfig = vi.hoisted(() => vi.fn());
const publishFaas = vi.hoisted(() => vi.fn());
const buildFaasCode = vi.hoisted(() => vi.fn(() => 'module.exports = ...'));
const buildSignatureUrl = vi.hoisted(() => vi.fn((id: string) => `https://magic.solutionsuite.cn/r?fid=${id}`));

vi.mock('../src/magic-token.js', () => ({
  readMagicToken,
  writeMagicToken
}));

vi.mock('../src/secret.js', () => ({
  readCredential
}));

vi.mock('../src/config.js', () => ({
  loadConfig,
  saveConfig,
  getConfigPath: () => '/tmp/config.json',
  configSlotId: () => 'slot_from_config',
  providerBaseUrl: () => 'https://l.garyyang.work',
  magicBuilderBaseUrl: () => 'https://magic.solutionsuite.cn',
  magicBuilderConfig: (c: { providers?: { 'magic-builder'?: unknown } }) => c.providers?.['magic-builder'] ?? {},
  magicBuilderFaasId: (c: { providers?: { 'magic-builder'?: { faasId?: string } } }) =>
    c.providers?.['magic-builder']?.faasId,
  magicBuilderFaasName: () => undefined,
  magicBuilderFallbackTitle: () => 'AI 牛马暂未开工',
  setMagicBuilderConfig: (c: Record<string, unknown>, patch: Record<string, unknown>) => ({
    ...c,
    providers: { ...(c.providers as object), 'magic-builder': patch }
  })
}));

vi.mock('../src/providers/magic-builder.js', () => ({
  DEFAULT_MAGIC_BUILDER_FAAS_NAME: 'agent_presence_preview',
  MagicBuilderProvider: class {
    buildFaasCode = buildFaasCode;
    publishFaas = publishFaas;
    buildSignatureUrl = buildSignatureUrl;
  }
}));

describe('publishMagicBuilderFaas', () => {
  let publishMagicBuilderFaas: typeof import('../src/cli/magic-builder-setup.js').publishMagicBuilderFaas;

  beforeEach(async () => {
    vi.clearAllMocks();
    loadConfig.mockResolvedValue({});
    saveConfig.mockResolvedValue(undefined);
    writeMagicToken.mockResolvedValue(undefined);
    readCredential.mockResolvedValue({ token: 'slot_bearer', slotId: 'slot_abc' });
    publishFaas.mockResolvedValue({
      id: 'rec_new',
      recordId: 'rec_new',
      faasPath: '/api/faas/rec_new',
      previewPath: '/r?fid=rec_new'
    });
    ({ publishMagicBuilderFaas } = await import('../src/cli/magic-builder-setup.js'));
  });

  it('publishes with an existing keyring token without prompting', async () => {
    readMagicToken.mockResolvedValue({ token: 'tok', source: 'keychain' });
    const acquireToken = vi.fn();

    const result = await publishMagicBuilderFaas({ acquireToken });

    expect(acquireToken).not.toHaveBeenCalled();
    expect(writeMagicToken).not.toHaveBeenCalled();
    expect(publishFaas).toHaveBeenCalledTimes(1);
    expect(result.url).toBe('https://magic.solutionsuite.cn/r?fid=rec_new');
    expect(result.tokenSource).toBe('keychain');
    expect(result.isUpdate).toBe(false);
  });

  it('prompts via acquireToken when no token is found and persists it to the keyring', async () => {
    readMagicToken.mockResolvedValue({});
    const acquireToken = vi.fn().mockResolvedValue('pasted-token');

    const result = await publishMagicBuilderFaas({ acquireToken });

    expect(acquireToken).toHaveBeenCalledTimes(1);
    expect(writeMagicToken).toHaveBeenCalledWith('pasted-token');
    expect(publishFaas).toHaveBeenCalledTimes(1);
    expect(result.tokenSource).toBe('keychain');
  });

  it('throws the onboarding help when no token and no acquireToken callback', async () => {
    readMagicToken.mockResolvedValue({});
    await expect(publishMagicBuilderFaas()).rejects.toThrow(/妙笔 bot|applink\.larkoffice\.com|send the message: dev/i);
  });

  it('throws the onboarding help when the prompt is cancelled (returns empty)', async () => {
    readMagicToken.mockResolvedValue({});
    const acquireToken = vi.fn().mockResolvedValue(undefined);
    await expect(publishMagicBuilderFaas({ acquireToken })).rejects.toThrow(/missing magic-builder token/);
    expect(writeMagicToken).not.toHaveBeenCalled();
  });

  it('reports isUpdate=true and reuses the existing record id', async () => {
    readMagicToken.mockResolvedValue({ token: 'tok', source: 'env' });
    loadConfig.mockResolvedValue({ providers: { 'magic-builder': { faasId: 'rec_existing' } } });
    publishFaas.mockResolvedValue({
      id: 'rec_existing',
      recordId: 'rec_existing',
      faasPath: '/api/faas/rec_existing',
      previewPath: '/r?fid=rec_existing'
    });

    const result = await publishMagicBuilderFaas();

    expect(publishFaas).toHaveBeenCalledWith(expect.objectContaining({ recordId: 'rec_existing' }));
    expect(result.isUpdate).toBe(true);
  });

  it('fails clearly when the l.garyyang credential is missing', async () => {
    readMagicToken.mockResolvedValue({ token: 'tok', source: 'env' });
    readCredential.mockResolvedValue(undefined);
    await expect(publishMagicBuilderFaas()).rejects.toThrow(/missing l\.garyyang slot credential/);
  });
});
