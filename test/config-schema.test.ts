import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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
import { loadValidatedConfig, parseConfigFile } from '../src/config-schema.js';

// The config loader (issue #106): a value that does not parse loads as missing with a warning naming its path, the
// rest of the file loads, unknown keys are kept, and a non-object root loads as {}. The hook path keeps the
// schema-free read (test/hook-graph.test.ts), so the hook never reaches this module.

describe('parseConfigFile — lenient parse', () => {
  it('drops a value that does not parse with its path and keeps its siblings', () => {
    const { config, issues } = parseConfigFile({
      render: { one: 5, zero: 'kept', unknownTemplate: 'kept' },
      usage: { pricing: { m: { input: 'x', output: 2 } } },
      plugins: { sources: { y: { match: { sessionId: { envKeys: 'X', payloadKeys: ['session_id'] } } }, z: null } },
      ttlMs: 'fast',
      provider: 'nope',
      slot_id: 'kept-slot'
    });

    expect(config.render).toEqual({ zero: 'kept', unknownTemplate: 'kept' });
    expect(config.usage?.pricing?.m).toEqual({ output: 2 });
    expect(config.plugins?.sources?.y).toEqual({
      match: { sessionId: { payloadKeys: ['session_id'] } }
    });
    expect(config.plugins?.sources?.z).toBeUndefined();
    expect(config.ttlMs).toBeUndefined();
    expect(config.provider).toBeUndefined();
    expect(config.slot_id).toBe('kept-slot');
    expect(issues).toEqual([
      { path: 'provider', reason: 'expected a known provider id' },
      { path: 'ttlMs', reason: 'expected a number' },
      { path: 'render.one', reason: 'expected a string' },
      { path: 'usage.pricing.m.input', reason: 'expected a number' },
      { path: 'plugins.sources.y.match.sessionId.envKeys', reason: 'expected an array' },
      { path: 'plugins.sources.z', reason: 'expected an object' }
    ]);
  });

  it('loads a non-object root as {} and reports it', () => {
    for (const root of [null, [1, 2], 'config', 5]) {
      const { config, issues } = parseConfigFile(root);
      expect(config).toEqual({});
      expect(issues).toEqual([{ path: 'config', reason: 'expected an object' }]);
    }
  });

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

  it('loads a file the schema accepts unchanged', () => {
    const raw: AppConfig = {
      provider: 'feishu-signature',
      providerBaseUrl: 'https://slot.example.com',
      previewBaseUrl: 'https://preview.example.com/',
      previewImageKey: 'img_test',
      previewTargetUrl: 'https://target.example.com',
      providers: {
        'feishu-signature': { baseUrl: 'https://slot.example.com' },
        'magic-builder': { faasId: 'rec_1', fallbackTitle: 'idle' }
      },
      slot_id: 'slot_a',
      slotId: 'slot_b',
      ttlMs: 60_000,
      debounceMs: 5_000,
      render: { zero: 'z', one: 'o', many: 'm' },
      usage: { showInSignature: true, signatureWindowDays: 7, pricing: { opus: { input: 15, cacheWrite1h: 30 } } },
      plugins: {
        sources: {
          codex: { handler: 'builtin:codex' },
          otheragent: { match: { sessionId: { payloadKeys: ['id'], payloadFirst: true } }, enabled: false }
        }
      }
    };
    const { config, issues } = parseConfigFile(raw);
    expect(issues).toEqual([]);
    expect(config).toEqual(raw);
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

describe('loadValidatedConfig', () => {
  let home: string;
  const savedEnv = new Map<string, string | undefined>();

  async function writeConfigFile(content: string): Promise<string> {
    const configPath = join(home, 'config.json');
    await writeFile(configPath, content, { mode: 0o600 });
    return configPath;
  }

  beforeEach(async () => {
    for (const name of [
      'HOME',
      'AGENT_PRESENCE_HOME',
      'AGENT_PRESENCE_CONFIG_FILE',
      'AGENT_SIGNATURE_HOME',
      'AGENT_SIGNATURE_CONFIG_FILE'
    ]) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    home = await mkdtemp(join(tmpdir(), 'agent-presence-config-schema-'));
    // `os.homedir()` reads HOME on POSIX, and the legacy config path hangs off it.
    process.env.HOME = home;
    process.env.AGENT_PRESENCE_HOME = home;
  });

  afterEach(async () => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(home, { recursive: true, force: true });
  });

  it('reads a legacy config when the new config does not exist, validated like any other', async () => {
    const legacyDir = join(home, '.codex', 'agent-signature');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'config.json'), JSON.stringify({ slot_id: 'slot_legacy' }));

    const { config, raw, issues } = await loadValidatedConfig();
    expect(issues).toEqual([]);
    expect(config).toEqual({ slot_id: 'slot_legacy' });
    expect(raw).toEqual(config);
  });

  it('returns the file as read, and reports each dropped value once per run', async () => {
    await writeConfigFile(JSON.stringify({ render: { one: 5 }, unknownTop: 1 }));
    const consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = await loadValidatedConfig();
      expect(first.raw).toEqual({ render: { one: 5 }, unknownTop: 1 });
      expect(first.config).toEqual({ render: {}, unknownTop: 1 });
      expect(consoleErrors).toHaveBeenCalledTimes(1);
      expect(consoleErrors.mock.calls[0]?.[0]).toBe('config: ignored render.one (expected a string)');

      // A second load of the same file — a command that takes over the queue loads it again — prints nothing new.
      await loadValidatedConfig();
      expect(consoleErrors).toHaveBeenCalledTimes(1);

      // The worker drops silently.
      const silent = await loadValidatedConfig({ report: false });
      expect(silent.config).toEqual(first.config);
      expect(consoleErrors).toHaveBeenCalledTimes(1);
    } finally {
      consoleErrors.mockRestore();
    }
  });
});
