import { describe, expect, it } from 'vite-plus/test';
import {
  configSlotId,
  debounceMs,
  defaultCommandProviderId,
  feishuSignatureConfig,
  magicBuilderBaseUrl,
  magicBuilderConfig,
  magicBuilderFaasId,
  magicBuilderFaasName,
  magicBuilderFallbackTitle,
  pluginSourcesConfig,
  previewBaseUrl,
  previewImageKey,
  previewTargetUrl,
  providerBaseUrl,
  providerId,
  renderTemplates,
  ttlMs,
  usagePricingOverrides,
  usageShowInSignature,
  usageSignatureWindowDays,
  type AppConfig
} from '../src/config.js';
import { parseConfigFile } from '../src/config-schema.js';

describe('parseConfigFile — lenient parse', () => {
  it('keeps keys the schema does not know at every level', () => {
    const raw = {
      unknownTop: { deep: [1] },
      providers: { 'feishu-signature': { baseUrl: 'https://slot.example.com', future: true }, futureProvider: 1 },
      render: { zero: 'z', legacy: 'l' },
      usage: { showInSignature: true, future: 'x', pricing: { m: { input: 1, perCall: 0.5 } } },
      plugins: { sources: { mine: { handler: 'builtin:codex', note: 'n', match: { future: 1 } } }, meta: 2 }
    };
    const { config, issues } = parseConfigFile(raw);
    expect(issues).toEqual([]);
    expect(config).toEqual(raw);
    expect(pluginSourcesConfig(config).mine).toEqual({ handler: 'builtin:codex', note: 'n', match: { future: 1 } });
  });
});

describe('parseConfigFile — every accessor reads the validated config like the raw file', () => {
  const RAW = {
    provider: 'l-garyyang',
    providerBaseUrl: 'https://legacy.example.com',
    previewBaseUrl: 'https://legacy-preview.example.com/',
    previewImageKey: 'img_legacy',
    previewTargetUrl: 'https://legacy-target.example.com',
    providers: {
      'feishu-signature': {
        baseUrl: 'https://slot.example.com',
        previewBaseUrl: 'https://preview.example.com/',
        previewImageKey: 'img_test',
        previewTargetUrl: 'https://target.example.com'
      },
      'magic-builder': { baseUrl: 'https://magic.example.com', faasId: 'rec_1', faasName: 'fn', fallbackTitle: 'idle' }
    },
    slot_id: 'slot_snake',
    slotId: 'slot_camel',
    ttlMs: 60_000,
    debounceMs: 5_000,
    render: { zero: 'ZERO', one: 'ONE {details}', many: 'MANY {details}' },
    usage: { showInSignature: true, signatureWindowDays: 7, pricing: { 'my-model': { input: 2, output: 8 } } },
    plugins: {
      sources: {
        codex: { handler: 'builtin:codex' },
        otheragent: { match: { sessionId: { payloadKeys: ['my_id'] } } }
      }
    }
  } as AppConfig;
  const { config } = parseConfigFile(RAW);

  it('resolves providers, slots, windows and templates identically', () => {
    // The accessors read their environment overrides before the config; no override is set here, so a difference
    // between the two configs would show in the result.
    for (const read of [
      (c: AppConfig) => providerId(c),
      (c: AppConfig) => defaultCommandProviderId(c),
      (c: AppConfig) => configSlotId(c),
      (c: AppConfig) => ttlMs(c),
      (c: AppConfig) => debounceMs(c),
      (c: AppConfig) => usageShowInSignature(c),
      (c: AppConfig) => usageSignatureWindowDays(c),
      (c: AppConfig) => providerBaseUrl(c),
      (c: AppConfig) => previewBaseUrl(c),
      (c: AppConfig) => previewImageKey(c),
      (c: AppConfig) => previewTargetUrl(c),
      (c: AppConfig) => magicBuilderBaseUrl(c),
      (c: AppConfig) => magicBuilderFaasId(c),
      (c: AppConfig) => magicBuilderFaasName(c),
      (c: AppConfig) => magicBuilderFallbackTitle(c)
    ]) {
      expect(read(config)).toEqual(read(RAW));
    }
    expect(providerId(config)).toBe('feishu-signature'); // the legacy l-garyyang alias
    expect(configSlotId(config)).toBe('slot_camel');
    expect(renderTemplates(config)).toEqual(renderTemplates(RAW));
    expect(usagePricingOverrides(config)).toEqual(usagePricingOverrides(RAW));
  });

  it('reads the provider, magic-builder and source tables identically', () => {
    expect(feishuSignatureConfig(config)).toEqual(feishuSignatureConfig(RAW));
    expect(magicBuilderConfig(config)).toEqual(magicBuilderConfig(RAW));
    expect(pluginSourcesConfig(config)).toEqual(pluginSourcesConfig(RAW));
  });
});

describe('parseConfigFile — types the readers accept today', () => {
  const raw = {
    ttlMs: '300000',
    debounceMs: '60000',
    slot_id: 123,
    slotId: 456,
    usage: { showInSignature: 'true', signatureWindowDays: '7', pricing: { m: { input: '2', output: '8.5' } } }
  };
  const { config, issues } = parseConfigFile(raw);

  it('loads durations, window days and prices as the numbers the readers compare and multiply', () => {
    expect(issues).toEqual([]);
    // `expireStaleSessions` compares, `syncSlot` debounces, `collectWindowUsage` subtracts days, and
    // `resolveRecordCost` multiplies prices: every reader gets the same number the raw value coerces to.
    expect(ttlMs(config)).toBe(300_000);
    expect(debounceMs(config)).toBe(60_000);
    expect(usageSignatureWindowDays(config)).toBe(7);
    expect(usagePricingOverrides(config)).toEqual({ m: { input: 2, output: 8.5 } });
  });

  it('loads numeric slot ids as the strings the credential store writes', () => {
    expect(configSlotId(config)).toBe('456');
    expect(config.slot_id).toBe('123');
  });

  it("loads showInSignature strings by the accessor's own 1/true rule", () => {
    expect(usageShowInSignature(config)).toBe(true);
    expect(usageShowInSignature(parseConfigFile({ usage: { showInSignature: '0' } }).config)).toBe(false);
    // A value the rule does not name is dropped, not guessed at.
    expect(parseConfigFile({ usage: { showInSignature: 'yes' } }).issues).toEqual([
      { path: 'usage.showInSignature', reason: 'expected a boolean' }
    ]);
  });

  it('loads the flag numbers 1 and 0, which enabled and disabled by truthiness on main', () => {
    expect(usageShowInSignature(parseConfigFile({ usage: { showInSignature: 1 } }).config)).toBe(true);
    expect(usageShowInSignature(parseConfigFile({ usage: { showInSignature: 0 } }).config)).toBe(false);
    expect(parseConfigFile({ usage: { showInSignature: 2 } }).issues).toEqual([
      { path: 'usage.showInSignature', reason: 'expected a boolean' }
    ]);
  });
});
