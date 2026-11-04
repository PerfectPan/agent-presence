import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AppConfig } from './config.js';
import { loadValidatedConfig, parseConfigFile } from './config-schema.js';

// The config loader: a value that does not parse loads as missing with a warning naming its path, the rest of the
// file loads, unknown keys are kept, and a non-object root loads as {}. The hook path keeps the schema-free read
// (test/hook-graph.test.ts), so the hook never reaches this module.

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

describe('parseConfigFile — types the readers accept today', () => {
  it('loads a numeric faasId as the string encodeURIComponent builds the preview url from', () => {
    const { config, issues } = parseConfigFile({ providers: { 'magic-builder': { faasId: 456 } } });
    expect(issues).toEqual([]);
    expect(config.providers?.['magic-builder']?.faasId).toBe('456');
  });

  it("drops durations and flags the accessor's env rule does not accept", () => {
    const dropped = parseConfigFile({ ttlMs: 'fast', usage: { showInSignature: 'yes' } });
    expect(dropped.config.ttlMs).toBeUndefined();
    expect(dropped.issues.map((issue) => issue.path)).toEqual(['ttlMs', 'usage.showInSignature']);
  });
});

describe('parseConfigFile — dropped fields are absent, not undefined-valued keys', () => {
  it('leaves no undefined-valued key at any level', () => {
    const { config } = parseConfigFile({
      ttlMs: 'fast',
      render: { one: 5, zero: 'z' },
      usage: { showInSignature: 'maybe', pricing: { 'gpt-5.5': { input: 'x', output: 2 } } }
    });
    expect(config).toStrictEqual({ render: { zero: 'z' }, usage: { pricing: { 'gpt-5.5': { output: 2 } } } });
  });

  it('leaves a partial override empty when all of its fields drop, so it cannot spread over a snapshot price', () => {
    const { config } = parseConfigFile({ usage: { pricing: { 'gpt-5.5': { input: 'x' } } } });
    const override = config.usage?.pricing?.['gpt-5.5'];
    expect(override).toStrictEqual({});
    expect(override).not.toHaveProperty('input');
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

  it('hands writes an empty object as the file base when the root is dropped', async () => {
    await writeConfigFile('null');

    const { config, raw, issues } = await loadValidatedConfig();

    expect(config).toEqual({});
    expect(raw).toEqual({});
    expect(issues).toEqual([{ path: 'config', reason: 'expected an object' }]);
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
