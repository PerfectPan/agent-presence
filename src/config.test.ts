import { describe, expect, it, vi } from 'vite-plus/test';
import {
  DEFAULT_MAGIC_BUILDER_BASE_URL,
  defaultCommandProviderId,
  magicBuilderBaseUrl,
  magicBuilderConfig,
  magicBuilderFaasId,
  magicBuilderFallbackTitle,
  setMagicBuilderConfig,
  configSlotId,
  feishuSignatureConfig,
  getConfigPath,
  getHomeDir,
  providerBaseUrl,
  providerId,
  renderTemplates
} from './config.js';
import type { AppConfig } from './config.js';

describe('renderTemplates', () => {
  it('omits unset template keys instead of overriding defaults with undefined', () => {
    expect(renderTemplates({})).toEqual({});
  });

  it('merges configured copy with environment overrides', () => {
    vi.stubEnv('AGENT_SIGNATURE_RENDER_ZERO', '机器歇菜中');
    vi.stubEnv('AGENT_SIGNATURE_RENDER_MANY', '{total} 个 AI 牛马正在赶工 | {details}');

    expect(
      renderTemplates({
        render: {
          zero: 'AI 牛马下班了',
          one: '{total} 个 AI 牛马正在搬砖 | {details}',
          many: '{total} 个 AI 牛马并行搬砖 | {details}'
        }
      })
    ).toEqual({
      zero: '机器歇菜中',
      one: '{total} 个 AI 牛马正在搬砖 | {details}',
      many: '{total} 个 AI 牛马正在赶工 | {details}'
    });

    vi.unstubAllEnvs();
  });
});

describe('agent-presence env aliases', () => {
  it('prefers AGENT_PRESENCE env names while keeping legacy AGENT_SIGNATURE names', () => {
    vi.stubEnv('AGENT_SIGNATURE_PROVIDER_BASE_URL', 'https://legacy.example.com');
    vi.stubEnv('AGENT_PRESENCE_PROVIDER_BASE_URL', 'https://presence.example.com');
    vi.stubEnv('AGENT_SIGNATURE_SLOT_ID', 'slot_legacy');
    vi.stubEnv('AGENT_PRESENCE_SLOT_ID', 'slot_presence');

    expect(providerBaseUrl({})).toBe('https://presence.example.com');
    expect(configSlotId({})).toBe('slot_presence');

    vi.unstubAllEnvs();
  });
});

describe('home directory', () => {
  it('defaults durable files to ~/.agent-presence', () => {
    vi.stubEnv('HOME', '/fake-home');
    vi.stubEnv('AGENT_PRESENCE_HOME', '');
    vi.stubEnv('AGENT_SIGNATURE_HOME', '');
    vi.unstubAllEnvs();
    vi.stubEnv('HOME', '/fake-home');

    expect(getHomeDir()).toBe('/fake-home/.agent-presence');
    expect(getConfigPath()).toBe('/fake-home/.agent-presence/config.json');

    vi.unstubAllEnvs();
  });
});

describe('provider configuration', () => {
  it('normalizes the legacy l-garyyang provider name to feishu-signature', () => {
    expect(providerId({ provider: 'l-garyyang' })).toBe('feishu-signature');
    expect(providerId({ provider: 'feishu-signature' })).toBe('feishu-signature');
  });

  it('reads Feishu signature provider config from provider-specific fields before legacy fields', () => {
    const config = {
      provider: 'feishu-signature' as const,
      providerBaseUrl: 'https://legacy.example.com',
      previewTargetUrl: 'https://legacy-target.example.com',
      providers: {
        'feishu-signature': {
          baseUrl: 'https://slot.example.com',
          previewBaseUrl: 'https://preview.example.com/',
          previewImageKey: 'img_test',
          previewTargetUrl: 'https://target.example.com'
        }
      }
    };

    expect(providerBaseUrl(config)).toBe('https://slot.example.com');
    expect(feishuSignatureConfig(config)).toEqual({
      baseUrl: 'https://slot.example.com',
      previewBaseUrl: 'https://preview.example.com/',
      previewImageKey: 'img_test',
      previewTargetUrl: 'https://target.example.com'
    });
  });
});

describe('providerId', () => {
  it('accepts magic-builder as a provider id', () => {
    expect(providerId({}, 'magic-builder')).toBe('magic-builder');
  });

  it('still maps legacy l-garyyang alias to feishu-signature', () => {
    expect(providerId({}, 'l-garyyang')).toBe('feishu-signature');
  });

  it('reads provider from config when no explicit override is given', () => {
    expect(providerId({ provider: 'feishu-signature' })).toBe('feishu-signature');
  });

  it('defaults to magic-builder when nothing is set', () => {
    expect(providerId({})).toBe('magic-builder');
  });

  it('rejects unknown providers', () => {
    expect(() => providerId({}, 'nope')).toThrow(/unsupported provider/);
  });
});

describe('defaultCommandProviderId', () => {
  it('keeps bare setup and url on magic-builder after a legacy config', () => {
    expect(defaultCommandProviderId({ provider: 'feishu-signature' })).toBe('magic-builder');
  });

  it('still honors an explicit provider override', () => {
    expect(defaultCommandProviderId({ provider: 'magic-builder' }, 'feishu-signature')).toBe('feishu-signature');
  });

  it('honors an environment provider override', () => {
    vi.stubEnv('AGENT_PRESENCE_PROVIDER', 'feishu-signature');
    expect(defaultCommandProviderId({ provider: 'magic-builder' })).toBe('feishu-signature');
    vi.unstubAllEnvs();
  });
});

describe('magic-builder config accessors', () => {
  it('returns an empty config when no providers block is set', () => {
    expect(magicBuilderConfig({})).toEqual({});
  });

  it('reads faasId out of nested provider config', () => {
    const config: AppConfig = { providers: { 'magic-builder': { faasId: 'rec_xyz' } } };
    expect(magicBuilderFaasId(config)).toBe('rec_xyz');
  });

  it('uses default base url when nothing is configured', () => {
    expect(magicBuilderBaseUrl({})).toBe(DEFAULT_MAGIC_BUILDER_BASE_URL);
  });

  it('uses config override for base url', () => {
    expect(magicBuilderBaseUrl({ providers: { 'magic-builder': { baseUrl: 'https://magic.example.com' } } })).toBe(
      'https://magic.example.com'
    );
  });

  it('uses render zero template as fallback title when no explicit fallback is configured', () => {
    expect(magicBuilderFallbackTitle({ render: { zero: 'AI 牛马下班了' } })).toBe('AI 牛马下班了');
  });

  it('prefers configured fallback over the render template', () => {
    expect(
      magicBuilderFallbackTitle({
        render: { zero: 'AI 牛马下班了' },
        providers: { 'magic-builder': { fallbackTitle: '默认文案' } }
      })
    ).toBe('默认文案');
  });
});

describe('setMagicBuilderConfig', () => {
  it('initializes providers block on a bare config', () => {
    const next = setMagicBuilderConfig({}, { faasId: 'rec_abc', faasName: 'agent_presence_preview' });
    expect(next.providers?.['magic-builder']).toEqual({ faasId: 'rec_abc', faasName: 'agent_presence_preview' });
  });

  it('merges into an existing magic-builder config without dropping other providers', () => {
    const base: AppConfig = {
      providers: {
        'feishu-signature': { baseUrl: 'https://l.garyyang.work' },
        'magic-builder': { faasName: 'preset_name' }
      }
    };
    const next = setMagicBuilderConfig(base, { faasId: 'rec_new' });
    expect(next.providers?.['magic-builder']).toEqual({ faasName: 'preset_name', faasId: 'rec_new' });
    expect(next.providers?.['feishu-signature']).toEqual({ baseUrl: 'https://l.garyyang.work' });
  });

  it('does not mutate the input config', () => {
    const base: AppConfig = { providers: { 'magic-builder': { faasName: 'x' } } };
    const snapshot = JSON.parse(JSON.stringify(base));
    setMagicBuilderConfig(base, { faasId: 'y' });
    expect(base).toEqual(snapshot);
  });
});
