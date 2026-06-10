import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAGIC_BUILDER_BASE_URL,
  magicBuilderBaseUrl,
  magicBuilderConfig,
  magicBuilderFaasId,
  magicBuilderFallbackTitle,
  providerId,
  setMagicBuilderConfig
} from '../src/config.js';
import type { AppConfig } from '../src/config.js';

describe('providerId', () => {
  it('accepts magic-builder as a provider id', () => {
    expect(providerId({}, 'magic-builder')).toBe('magic-builder');
  });

  it('still maps legacy l-garyyang alias to feishu-signature', () => {
    expect(providerId({}, 'l-garyyang')).toBe('feishu-signature');
  });

  it('reads provider from config when no explicit override is given', () => {
    expect(providerId({ provider: 'magic-builder' })).toBe('magic-builder');
  });

  it('falls back to feishu-signature when nothing is set', () => {
    expect(providerId({})).toBe('feishu-signature');
  });

  it('rejects unknown providers', () => {
    expect(() => providerId({}, 'nope')).toThrow(/unsupported provider/);
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
