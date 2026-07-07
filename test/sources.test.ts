import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config.js';
import { BUILTIN_SOURCE_IDS } from '../src/cli/hook-context.js';
import {
  buildMatchSource,
  curatedEnv,
  describeSources,
  resetSourcePluginCacheForTests,
  resolveHookContextForSource
} from '../src/sources.js';

let workDir: string;
let configPath: string;
let logPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'agent-presence-sources-'));
  configPath = join(workDir, 'config.json');
  logPath = join(workDir, 'agent-presence.log');
  // A trusted (user-owned, non-world-writable) config file is a precondition
  // for honoring `handler` entries; write one so handler tests aren't refused.
  writeFileSync(configPath, '{}', { mode: 0o600 });
  process.env.AGENT_PRESENCE_CONFIG_FILE = configPath;
  process.env.AGENT_PRESENCE_LOG_FILE = logPath;
  resetSourcePluginCacheForTests();
});

afterEach(async () => {
  delete process.env.AGENT_PRESENCE_CONFIG_FILE;
  delete process.env.AGENT_PRESENCE_LOG_FILE;
  resetSourcePluginCacheForTests();
  await rm(workDir, { recursive: true, force: true });
});

describe('curatedEnv', () => {
  it('strips credential-bearing env keys but keeps ordinary ones', () => {
    const curated = curatedEnv({
      HOME: '/Users/me',
      AGENT_PRESENCE_TOKEN: 'secret',
      FEISHU_SLOT_CREDENTIAL: 'secret',
      MAGIC_TOKEN: 'secret',
      AGENT_PRESENCE_SLOT_ID: 'slot_x',
      SOME_API_KEY: 'secret',
      MYAGENT_SESSION_ID: 'sess-1'
    });

    expect(curated.HOME).toBe('/Users/me');
    expect(curated.MYAGENT_SESSION_ID).toBe('sess-1');
    expect(curated.AGENT_PRESENCE_TOKEN).toBeUndefined();
    expect(curated.FEISHU_SLOT_CREDENTIAL).toBeUndefined();
    expect(curated.MAGIC_TOKEN).toBeUndefined();
    expect(curated.AGENT_PRESENCE_SLOT_ID).toBeUndefined();
    expect(curated.SOME_API_KEY).toBeUndefined();
  });
});

describe('resolveHookContextForSource — built-ins', () => {
  it('resolves every built-in source through the registry', async () => {
    const context = await resolveHookContextForSource('codex', { session_id: 'codex-1', cwd: '/repo' }, {});
    expect(context.sessionId).toBe('codex-1');
    expect(context.project).toBe('/repo');
    expect(BUILTIN_SOURCE_IDS).toEqual(['codex', 'claude', 'gemini', 'opencode', 'pi']);
  });

  it('lets a built-in source win over a same-id config entry', async () => {
    const config: AppConfig = {
      plugins: { sources: { codex: { match: { sessionId: { payloadKeys: ['ignored'] } } } } }
    };
    const context = await resolveHookContextForSource('codex', { session_id: 'codex-1', cwd: '/repo' }, config);
    expect(context.sessionId).toBe('codex-1');
    expect(context.project).toBe('/repo');
  });

  it('returns an empty context for a truly unknown source with no config', async () => {
    const context = await resolveHookContextForSource('mystery', { session_id: 'x' }, {});
    expect(context).toEqual({});
  });
});

describe('resolveHookContextForSource — declarative match', () => {
  it('reads a nested payload with env-vs-payload precedence like the built-ins', async () => {
    const config: AppConfig = {
      plugins: {
        sources: {
          otheragent: {
            match: {
              sessionId: {
                payloadKeys: ['session_id', 'sessionId'],
                nestedPayloadKeys: ['event', 'session'],
                payloadFirst: true
              },
              project: { payloadKeys: ['cwd'], payloadFirst: true },
              event: { payloadKeys: ['hook_event_name'], payloadFirst: true }
            }
          }
        }
      }
    };

    const context = await resolveHookContextForSource(
      'otheragent',
      { event: { session: { session_id: 'sess-42' } }, cwd: '/work', hook_event_name: 'Stop' },
      config
    );

    expect(context.sessionId).toBe('sess-42');
    expect(context.project).toBe('/work');
    expect(context.event).toBe('Stop');
  });

  it('falls back to env keys when the payload lacks the field', async () => {
    const source = buildMatchSource('otheragent', {
      sessionId: { envKeys: ['OTHER_SESSION_ID'], payloadKeys: ['session_id'] }
    });
    const context = source.resolveHookContext({}, { OTHER_SESSION_ID: 'from-env' });
    expect(context.sessionId).toBe('from-env');
  });

  it('skips a source entry with neither handler nor match', async () => {
    const config: AppConfig = { plugins: { sources: { otheragent: {} } } };
    const context = await resolveHookContextForSource('otheragent', { session_id: 'x' }, config);
    expect(context).toEqual({});
  });
});

describe('resolveHookContextForSource — JS handler', () => {
  function writeHandler(fileName: string, body: string, mode = 0o600): string {
    const handlerPath = join(workDir, fileName);
    writeFileSync(handlerPath, body, { mode });
    return handlerPath;
  }

  it('loads a well-formed handler module and resolves through it', async () => {
    const handlerPath = writeHandler(
      'myagent.mjs',
      `export default {
        id: 'myagent',
        resolveHookContext(payload) {
          return { sessionId: payload.session_id, project: payload.cwd, event: payload.hook_event_name };
        }
      };`
    );
    const config: AppConfig = { plugins: { sources: { myagent: { handler: handlerPath } } } };

    const context = await resolveHookContextForSource(
      'myagent',
      { session_id: 'handler-1', cwd: '/h', hook_event_name: 'SessionStart' },
      config
    );
    expect(context).toEqual({ sessionId: 'handler-1', project: '/h', event: 'SessionStart' });
  });

  it('does not receive credential env vars', async () => {
    const handlerPath = writeHandler(
      'myagent-env.mjs',
      `export default {
        id: 'myagent',
        resolveHookContext(_payload, env) {
          return { sessionId: env.AGENT_PRESENCE_TOKEN ?? 'no-token' };
        }
      };`
    );
    process.env.AGENT_PRESENCE_TOKEN = 'super-secret';
    try {
      const config: AppConfig = { plugins: { sources: { myagent: { handler: handlerPath } } } };
      const context = await resolveHookContextForSource('myagent', {}, config);
      expect(context.sessionId).toBe('no-token');
    } finally {
      delete process.env.AGENT_PRESENCE_TOKEN;
    }
  });

  it('refuses a handler whose exported id does not match the source id', async () => {
    const handlerPath = writeHandler(
      'wrong-id.mjs',
      `export default { id: 'other', resolveHookContext() { return { sessionId: 'x' }; } };`
    );
    const config: AppConfig = { plugins: { sources: { myagent: { handler: handlerPath } } } };
    const context = await resolveHookContextForSource('myagent', {}, config);
    expect(context).toEqual({});
  });

  it('refuses a module without a valid default export', async () => {
    const handlerPath = writeHandler('bad-export.mjs', `export const nope = 1;`);
    const config: AppConfig = { plugins: { sources: { myagent: { handler: handlerPath } } } };
    const context = await resolveHookContextForSource('myagent', {}, config);
    expect(context).toEqual({});
  });

  it('fails open when the handler throws', async () => {
    const handlerPath = writeHandler(
      'throwing.mjs',
      `export default { id: 'myagent', resolveHookContext() { throw new Error('boom'); } };`
    );
    const config: AppConfig = { plugins: { sources: { myagent: { handler: handlerPath } } } };
    const context = await resolveHookContextForSource('myagent', {}, config);
    expect(context).toEqual({});
  });

  it('refuses a symlinked handler file', async () => {
    const realPath = writeHandler(
      'real.mjs',
      `export default { id: 'myagent', resolveHookContext() { return { sessionId: 'x' }; } };`
    );
    const linkPath = join(workDir, 'link.mjs');
    symlinkSync(realPath, linkPath);
    const config: AppConfig = { plugins: { sources: { myagent: { handler: linkPath } } } };
    const context = await resolveHookContextForSource('myagent', {}, config);
    expect(context).toEqual({});
  });

  it('refuses a world-writable handler file', async () => {
    const handlerPath = writeHandler(
      'writable.mjs',
      `export default { id: 'myagent', resolveHookContext() { return { sessionId: 'x' }; } };`,
      0o666
    );
    chmodSync(handlerPath, 0o666);
    const config: AppConfig = { plugins: { sources: { myagent: { handler: handlerPath } } } };
    const context = await resolveHookContextForSource('myagent', {}, config);
    expect(context).toEqual({});
  });

  it('refuses a handler when config.json is world-writable', async () => {
    chmodSync(configPath, 0o666);
    const handlerPath = writeHandler(
      'ok.mjs',
      `export default { id: 'myagent', resolveHookContext() { return { sessionId: 'x' }; } };`
    );
    const config: AppConfig = { plugins: { sources: { myagent: { handler: handlerPath } } } };
    const context = await resolveHookContextForSource('myagent', {}, config);
    expect(context).toEqual({});
  });
});

describe('describeSources', () => {
  it('lists built-in sources plus configured ones and flags shadowing', () => {
    const config: AppConfig = {
      plugins: { sources: { myagent: { handler: '/x.mjs' }, codex: { match: {} } } }
    };
    expect(describeSources(config)).toEqual([
      { id: 'codex', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'claude', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'gemini', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'opencode', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'pi', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'myagent', origin: 'config', shadowedByBuiltin: false },
      { id: 'codex', origin: 'config', shadowedByBuiltin: true }
    ]);
  });

  it('lists just the built-ins when no config sources are set', () => {
    expect(describeSources({})).toEqual([
      { id: 'codex', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'claude', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'gemini', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'opencode', origin: 'builtin', shadowedByBuiltin: false },
      { id: 'pi', origin: 'builtin', shadowedByBuiltin: false }
    ]);
  });
});
