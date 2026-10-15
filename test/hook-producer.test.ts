import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getStatePath, type AppConfig, type SourcePluginConfig } from '../src/config.js';
import { hookEventLogEvent } from '../src/cli/hook-diagnostics.js';
import { formatLogEvent } from '../src/log.js';
import { RECORD_VERSION, queuePaths, writeTombstone } from '../src/queue/files.js';
import { listQueue, readQueueFile } from '../src/queue/reader.js';
import type { QueueRecord } from '../src/queue/schema.js';
import { createEmptyState } from '../src/state.js';
import { loadState } from '../src/state-store.js';
import { billableSources } from '../src/usage/billable-sources.js';
import {
  loadSourcePluginForValidation,
  resolveHookContextForSource,
  resetSourcePluginCacheForTests,
  type SourceDiagnostics
} from '../src/sources.js';
import { hook } from '../src/cli/commands/hook.js';
import {
  captureHookWorkerStarts,
  drainQueue,
  hookWorkerStarts,
  restoreHookWorkerStarts
} from './hook-producer-support.js';

// The hook as the queue's producer (Plan 0003 3.3): what each hook path writes into the queue, that it writes no log
// line and no stop request, and that the worker logs the lines the hook logged before the queue. Every case runs the
// hook, reads the records back through the queue reader, and drives one in-process worker run (`drainQueue`) to check
// the lines the worker logs for them.

const publishValueMock = vi.hoisted(() => vi.fn<(value: string) => Promise<void>>());
const stdinPayload = vi.hoisted(() => ({ current: {} as unknown }));
// Lets a test fail the run's first record write, the way a full or blocked queue does, while the queue stays writable
// for the failure record after it.
const produceCalls = vi.hoisted(() => ({ failFirst: false }));

vi.mock('../src/providers/registry.js', () => ({
  createProvider: () => ({
    id: 'feishu-signature',
    publishValue: publishValueMock
  })
}));

vi.mock('../src/queue/produce.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queue/produce.js')>();
  return {
    ...actual,
    produceRecord: async (...args: Parameters<typeof actual.produceRecord>) => {
      if (produceCalls.failFirst) {
        produceCalls.failFirst = false;
        throw new Error('first write failed');
      }
      return actual.produceRecord(...args);
    }
  };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    // A HOME whose passwd entry is gone makes os.homedir() throw; the flag stands in for that.
    getStatePath: () => {
      if (process.env.FAIL_STATE_PATH === '1') {
        throw new Error('no passwd entry for the current user');
      }
      return actual.getStatePath();
    }
  };
});

vi.mock('../src/secret.js', () => ({
  readCredential: vi
    .fn<typeof import('../src/secret.js').readCredential>()
    .mockResolvedValue({ token: 'test-token', slotId: 'test-slot' })
}));

vi.mock('../src/cli/io.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/io.js')>('../src/cli/io.js');
  return {
    ...actual,
    readStdinJson: async () => stdinPayload.current
  };
});

vi.mock('../src/cli/deferred-update.js', () => ({
  scheduleDeferredRenderedUpdate: async () => undefined,
  // The real scheduling settles the owed rendered sync in its locked save (Plan 0003 3.5); the mock makes the same
  // state change without spawning the detached flush, so the worker's follow-up lane settles with it.
  scheduleDeferredRenderedUpdateForResult: async (
    result: { status: string; reason?: string },
    options: { statePath: string; delayMs: number; now: number }
  ) => {
    if (result.status !== 'skipped' || (result.reason !== 'debounced' && result.reason !== 'rate-limited')) {
      return;
    }
    const { settleRenderedSync } = await import('../src/queue/owed.js');
    const { loadState, saveState, withStateLock } = await import('../src/state-store.js');
    await withStateLock(options.statePath, async () => {
      const state = await loadState(options.statePath);
      state.pendingSlotFlushAt = options.now + options.delayMs;
      settleRenderedSync(state);
      await saveState(state, options.statePath);
    });
  }
}));

const NOW = new Date(2026, 9, 9, 15, 0).getTime();

const MANAGED_ENV_KEYS = [
  'HOME',
  'AGENT_PRESENCE_HOME',
  'AGENT_PRESENCE_STATE_FILE',
  'AGENT_PRESENCE_CONFIG_FILE',
  'AGENT_PRESENCE_LOG_FILE',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_HOME',
  'XDG_DATA_HOME',
  'AGENT_PRESENCE_USAGE_IN_SIGNATURE'
] as const;

let homeDir: string;
let logPath: string;
let stdoutWrites: string[];

async function writeConfig(config: AppConfig): Promise<void> {
  await writeFile(join(homeDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
}

async function runHook(args: string[], payload: unknown, env: Record<string, string> = {}): Promise<void> {
  stdinPayload.current = payload;
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  stdoutWrites.length = 0;
  await hook(args);
}

/** The records in the queue, parsed the way an applier parses them. */
async function writtenRecords(): Promise<QueueRecord[]> {
  const { records } = await listQueue(getStatePath());
  const written: QueueRecord[] = [];
  for (const file of records) {
    const read = await readQueueFile(file);
    if (read.status !== 'record') {
      throw new Error(`record ${file.id} did not parse: ${read.status}`);
    }
    written.push(read.record);
  }
  return written;
}

async function readLog(): Promise<string> {
  try {
    return await readFile(logPath, 'utf8');
  } catch {
    return '';
  }
}

/** The worker applied the queue and logged `text`, the line the hook logged before the queue. */
async function drainAndExpectLogLine(text: string): Promise<void> {
  await drainQueue();
  expect(await readLog()).toContain(text);
}

function errorRecord(records: QueueRecord[], message: string): QueueRecord {
  const record = records.find((candidate) => candidate.kind === 'error' && candidate.message === message);
  expect(record, `no error record with message ${message}`).toBeDefined();
  return record!;
}

/** Whether any file under `dir` holds `text`. */
async function anyFileContains(dir: string, text: string): Promise<boolean> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const content = await readFile(path).catch(() => null);
    if (content?.includes(text)) {
      return true;
    }
  }
  return false;
}

beforeEach(async () => {
  const previousEnv = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-hook-producer-'));
  logPath = join(homeDir, 'agent-presence.log');
  process.env.HOME = homeDir;
  process.env.AGENT_PRESENCE_HOME = homeDir;
  process.env.AGENT_PRESENCE_LOG_FILE = logPath;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  captureHookWorkerStarts();
  resetSourcePluginCacheForTests();
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Uint8Array | string) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  publishValueMock.mockReset();
  publishValueMock.mockResolvedValue(undefined);
  return async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    restoreHookWorkerStarts();
    resetSourcePluginCacheForTests();
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  };
});

describe('hook producer — event records', () => {
  it('records the event with its payload keys and the boundary scanEnv, and starts a worker', async () => {
    await runHook(
      ['--source', 'claude', '--event', 'SessionStart'],
      { session_id: 's1', cwd: '/work/repo', hook_event_name: 'SessionStart' },
      { CLAUDE_CONFIG_DIR: '/fake-claude' }
    );

    expect(hookWorkerStarts.requested).toBe(1);
    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      v: RECORD_VERSION,
      id: expect.any(String),
      recordedAt: NOW,
      epoch: 0,
      kind: 'event',
      source: 'claude',
      event: 'SessionStart',
      sessionId: 's1',
      project: '/work/repo',
      payloadKeys: ['cwd', 'hook_event_name', 'session_id'],
      scanEnv: { CLAUDE_CONFIG_DIR: '/fake-claude' }
    });

    // The worker applies the record: the session is running and the boundary refresh is done.
    await drainQueue();
    const state = await loadState(getStatePath());
    expect(state.sessions['s1']).toMatchObject({ source: 'claude', status: 'running', startedAt: NOW });
    expect(state.usageSnapshots).toBeUndefined();
  });

  it('records an empty scanEnv when the source lists no variables, none is set, or the source is not built-in', async () => {
    await runHook(['--source', 'grok', '--event', 'SessionStart'], { sessionId: 'grok-1' });
    await runHook(['--source', 'claude', '--event', 'SessionStart'], { session_id: 'claude-1' });
    await writeConfig({
      plugins: { sources: { otheragent: { match: { sessionId: { payloadKeys: ['session_id'] } } } } }
    });
    await runHook(['--source', 'otheragent', '--event', 'SessionStart'], { session_id: 'other-1' });

    // The three runs recorded in the same mocked millisecond: order by source for the comparison.
    const sources = (await writtenRecords())
      .map((record) => {
        if (record.kind !== 'event') {
          throw new Error(`expected an event record, got ${record.kind}`);
        }
        return [record.source, record.scanEnv] as const;
      })
      .sort(([left], [right]) => (left < right ? -1 : 1));
    expect(sources).toEqual([
      ['claude', {}],
      ['grok', {}],
      ['otheragent', {}]
    ]);
  });

  it('carries the dsh usage event in the record, and the worker appends it with the record id', async () => {
    await runHook(['--source', 'dsh', '--event', 'Stop'], {
      session_id: 'dsh-1',
      model: 'm-test',
      usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });

    const [record] = await writtenRecords();
    expect(record?.kind === 'event' && record.usage).toEqual({
      source: 'dsh',
      model: 'm-test',
      timestamp: NOW,
      inputTokens: 5,
      outputTokens: 2,
      cacheWriteTokens: 0,
      cacheReadTokens: 0
    });
    const id = record?.kind === 'event' ? record.id : undefined;

    await drainQueue();
    const usageLog = await readFile(join(homeDir, 'usage-events.log'), 'utf8');
    expect(usageLog).toContain('"model":"m-test"');
    expect(usageLog).toContain(`"id":"${id}"`);
  });
});

describe('hook producer — skip records', () => {
  it('records missing-session-id, and the worker logs the two lines the hook logged, in order', async () => {
    await runHook(['--source', 'codex', '--event', 'Heartbeat'], { cwd: '/work/repo' });

    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'skip',
      code: 'missing-session-id',
      source: 'codex',
      nativeEvent: 'Heartbeat',
      project: '/work/repo',
      payloadKeys: ['cwd']
    });

    await drainQueue();
    // The diagnostic line, built the way the direct path built it (writeHookDiagnostic, project included), then the
    // skip line.
    const diagnostic = formatLogEvent(
      hookEventLogEvent({ source: 'codex', event: 'Heartbeat', project: '/work/repo', payloadKeys: ['cwd'] })
    );
    expect(diagnostic).toContain('hasSessionId=false');
    expect(diagnostic).toContain('project=/work/repo');
    const skip = 'hook skipped: missing session id for source=codex event=Heartbeat';
    const log = await readLog();
    const diagnosticAt = log.indexOf(diagnostic);
    const skipAt = log.indexOf(skip);
    expect(diagnosticAt).toBeGreaterThanOrEqual(0);
    expect(skipAt).toBeGreaterThan(diagnosticAt);
  });

  it('records no-presence-source for an agent with no presence source', async () => {
    await runHook(['--agent', 'claude-code'], {
      hook_event_name: 'SessionStart',
      session_id: 'cursor-1',
      cwd: '/work/repo',
      cursor_version: '3.13.25'
    });

    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'skip',
      code: 'no-presence-source',
      agent: 'cursor',
      nativeEvent: 'SessionStart'
    });
    await drainAndExpectLogLine('hook skipped: no presence source for agent=cursor event=SessionStart');
  });

  it('records ignored-event for an event the source ignores', async () => {
    await runHook(['--agent', 'pi'], { type: 'session_start', sessionId: 'pi-1' });

    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'skip',
      code: 'ignored-event',
      source: 'pi',
      nativeEvent: 'session_start'
    });
    await drainAndExpectLogLine('hook skipped: ignored event source=pi event=session_start');
  });
});

describe('hook producer — source-resolution diagnostics', () => {
  /**
   * Run a hook against a configured source and return its records: a refusal leaves no session id, so the run also
   * records the missing-session-id skip.
   */
  async function runSourceWith(entry: SourcePluginConfig, event = 'SessionStart'): Promise<QueueRecord[]> {
    await writeConfig({ plugins: { sources: { mysrc: entry } } });
    await runHook(['--source', 'mysrc', '--event', event], { session_id: 'unused', cwd: '/work/repo' });
    return writtenRecords();
  }

  async function handlerSource(body: string, name = 'handler.mjs', mode = 0o600): Promise<string> {
    const path = join(homeDir, name);
    await writeFile(path, body, { mode });
    return path;
  }

  const goodHandler = (id: string) =>
    `export default {\n` +
    `  id: '${id}',\n` +
    `  resolveHookContext(payload) { return { sessionId: payload.session_id, project: payload.cwd }; }\n` +
    `};`;

  it('records source-skipped for an entry with neither handler nor match', async () => {
    const records = await runSourceWith({});
    expect(errorRecord(records, 'source skipped source=mysrc reason=no-handler-or-match')).toMatchObject({
      kind: 'error',
      code: 'source-skipped',
      source: 'mysrc'
    });
    await drainAndExpectLogLine('source skipped source=mysrc reason=no-handler-or-match');
  });

  it('records source-refused for a symlinked handler', async () => {
    const real = await handlerSource(goodHandler('mysrc'), 'real.mjs');
    const link = join(homeDir, 'link.mjs');
    await symlink(real, link);

    const records = await runSourceWith({ handler: link });
    expect(errorRecord(records, 'source refused source=mysrc reason=symlink-handler')).toMatchObject({
      kind: 'error',
      code: 'source-refused'
    });
    await drainAndExpectLogLine('source refused source=mysrc reason=symlink-handler');
  });

  it('records source-refused for a handler package that cannot be resolved', async () => {
    const records = await runSourceWith({ handler: 'no-such-package-xyz' });
    const record = records.find(
      (candidate) =>
        candidate.kind === 'error' &&
        candidate.message.startsWith('source refused source=mysrc reason=specifier-unresolved error=')
    );
    expect(record).toMatchObject({ kind: 'error', code: 'source-refused' });
    await drainAndExpectLogLine('source refused source=mysrc reason=specifier-unresolved error=');
  });

  it('records source-refused for a world-writable handler', async (context) => {
    if (process.getuid?.() === 0) {
      context.skip();
    }
    const path = await handlerSource(goodHandler('mysrc'), 'wide.mjs', 0o666);
    await chmod(path, 0o666);

    const records = await runSourceWith({ handler: path });
    expect(errorRecord(records, 'source refused source=mysrc reason=handler-world-writable')).toMatchObject({
      kind: 'error',
      code: 'source-refused'
    });
    await drainAndExpectLogLine('source refused source=mysrc reason=handler-world-writable');
  });

  it('records source-refused when the config file is untrusted', async (context) => {
    if (process.getuid?.() === 0) {
      context.skip();
    }
    const path = await handlerSource(goodHandler('mysrc'));
    await writeConfig({ plugins: { sources: { mysrc: { handler: path } } } });
    await chmod(join(homeDir, 'config.json'), 0o666);
    await runHook(['--source', 'mysrc', '--event', 'SessionStart'], { session_id: 'unused', cwd: '/work/repo' });

    const records = await writtenRecords();
    expect(errorRecord(records, 'source refused source=mysrc reason=untrusted-config')).toMatchObject({
      kind: 'error',
      code: 'source-refused'
    });
    await drainAndExpectLogLine('source refused source=mysrc reason=untrusted-config');
  });

  it('records source-invalid for an unknown built-in handler', async () => {
    const records = await runSourceWith({ handler: 'builtin:nonexistent' });
    expect(
      errorRecord(records, 'source invalid source=mysrc reason=unknown-builtin builtin=nonexistent')
    ).toMatchObject({
      kind: 'error',
      code: 'source-invalid'
    });
    await drainAndExpectLogLine('source invalid source=mysrc reason=unknown-builtin builtin=nonexistent');
  });

  it('records source-invalid for a handler without a default export', async () => {
    const path = await handlerSource(`export const nope = 1;`);

    const records = await runSourceWith({ handler: path });
    expect(errorRecord(records, 'source invalid source=mysrc reason=bad-default-export')).toMatchObject({
      kind: 'error',
      code: 'source-invalid'
    });
    await drainAndExpectLogLine('source invalid source=mysrc reason=bad-default-export');
  });

  it('records source-id-mismatch for a handler with another id', async () => {
    const path = await handlerSource(goodHandler('other'));

    const records = await runSourceWith({ handler: path });
    expect(errorRecord(records, 'source id mismatch source=mysrc handlerId=other')).toMatchObject({
      kind: 'error',
      code: 'source-id-mismatch'
    });
    await drainAndExpectLogLine('source id mismatch source=mysrc handlerId=other');
  });

  it('records source-loaded and still records the event the handler resolves', async () => {
    const path = await handlerSource(goodHandler('mysrc'));

    const records = await runSourceWith({ handler: path });
    expect(errorRecord(records, `source loaded source=mysrc handler=${path}`)).toMatchObject({
      kind: 'error',
      code: 'source-loaded'
    });
    const events = records.filter((record) => record.kind === 'event');
    expect(events).toEqual([
      expect.objectContaining({ kind: 'event', source: 'mysrc', event: 'SessionStart', sessionId: 'unused' })
    ]);

    await drainQueue();
    const log = await readLog();
    expect(log).toContain(`source loaded source=mysrc handler=${path}`);
    expect(log).toContain('event=SessionStart');
  });

  it('records source-load-failed for a handler module that throws on import', async () => {
    const path = await handlerSource(`throw new Error('module exploded');`, 'exploding.mjs');

    const records = await runSourceWith({ handler: path });
    expect(errorRecord(records, 'source load failed source=mysrc error=Error')).toMatchObject({
      kind: 'error',
      code: 'source-load-failed'
    });
    await drainAndExpectLogLine('source load failed source=mysrc error=Error');
  });

  it('records source-resolve-failed for a handler whose resolver throws', async () => {
    const path = await handlerSource(
      `export default { id: 'mysrc', resolveHookContext() { throw new Error('resolver boom'); } };`,
      'throwing.mjs'
    );

    const records = await runSourceWith({ handler: path });
    expect(errorRecord(records, 'source resolve failed source=mysrc error=Error')).toMatchObject({
      kind: 'error',
      code: 'source-resolve-failed'
    });
    await drainAndExpectLogLine('source resolve failed source=mysrc error=Error');
  });
});

describe('hook producer — failures and quietness', () => {
  it('records hook failed for an error from the interpretation and starts a worker for it', async () => {
    await runHook(['--agent', 'bogus'], {});

    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'error',
      code: 'hook-failed',
      message: 'hook failed: Agent "bogus" has no hook dialect'
    });
    // The failure record asked for a worker like any record (3.3); the worker logs the line.
    expect(hookWorkerStarts.requested).toBe(1);
    await drainAndExpectLogLine('hook failed: Agent');
  });

  it('a run with a failed write records one hook failed and requests one start', async () => {
    produceCalls.failFirst = true;
    await runHook(['--source', 'claude', '--event', 'Heartbeat'], { session_id: 's1' });

    // The event record was lost to the failed write; its failure record carries the start request (3.3).
    expect(await writtenRecords()).toHaveLength(1);
    expect((await writtenRecords())[0]).toMatchObject({ kind: 'error', code: 'hook-failed' });
    expect(hookWorkerStarts.requested).toBe(1);
  });

  it('prints its output with exit code 0 when the state path cannot be read', async () => {
    process.env.FAIL_STATE_PATH = '1';
    try {
      await runHook(['--source', 'claude', '--event', 'Heartbeat'], { session_id: 's1' });

      expect(stdoutWrites).toEqual(['{}\n']);
      expect(process.exitCode).toBeUndefined();
      // Nothing was recorded: the run never reached the queue.
      expect(await readdir(homeDir)).not.toContain('state.json.queue');
    } finally {
      delete process.env.FAIL_STATE_PATH;
    }
  });

  it('writes no log line and no stop request, in an event run and in a skip run', async () => {
    await runHook(['--source', 'claude', '--event', 'Heartbeat'], { session_id: 's1' });
    await runHook(['--source', 'codex', '--event', 'Heartbeat'], {});

    expect(existsSync(logPath)).toBe(false);
    const stopRequests = (await readdir(homeDir)).filter((name) => name.startsWith('state.json.worker.stop.'));
    expect(stopRequests).toEqual([]);
    // Records recorded in the same millisecond apply in file-name order, which is not the write order.
    expect((await writtenRecords()).map((record) => record.kind)).toEqual(expect.arrayContaining(['event', 'skip']));
    expect(await writtenRecords()).toHaveLength(2);
  });

  it('prints its output and records nothing against a read-only queue directory', async (context) => {
    if (process.getuid?.() === 0) {
      context.skip();
    }
    await mkdir(queuePaths(getStatePath()).queueDir, { recursive: true, mode: 0o700 });
    await chmod(queuePaths(getStatePath()).queueDir, 0o500);
    try {
      await runHook(['--source', 'claude', '--event', 'Heartbeat'], { session_id: 's1' });

      expect(stdoutWrites).toEqual(['{}\n']);
      expect(process.exitCode).toBeUndefined();
      expect(await listQueue(getStatePath())).toEqual({ records: [], temporary: [] });
      expect(existsSync(logPath)).toBe(false);
      expect(hookWorkerStarts.requested).toBe(0);
    } finally {
      await chmod(queuePaths(getStatePath()).queueDir, 0o700);
    }
  });

  it('carries no payload value into any file, before and after the worker applied the record', async () => {
    const secret = 'qp-9f2a-unique-prompt-body';
    await runHook(['--source', 'claude', '--event', 'UserPromptSubmit'], {
      session_id: 's9',
      cwd: '/work/repo',
      prompt: secret
    });

    expect(await anyFileContains(homeDir, secret)).toBe(false);

    await drainQueue();
    expect(await anyFileContains(homeDir, secret)).toBe(false);
    const state = await loadState(getStatePath());
    expect(state.sessions['s9']).toMatchObject({ status: 'running' });
  });

  it('records nothing and starts no worker while the tombstone exists', async () => {
    await writeTombstone(getStatePath());
    await runHook(['--source', 'claude', '--event', 'SessionStart'], { session_id: 's1', cwd: '/work/repo' });

    expect(await listQueue(getStatePath())).toEqual({ records: [], temporary: [] });
    expect(hookWorkerStarts.requested).toBe(0);
    expect((await loadState(getStatePath())).sessions).toEqual(createEmptyState().sessions);
  });
});

describe('source resolution outside the hook still writes its lines', () => {
  beforeEach(async () => {
    await rm(logPath, { force: true });
  });

  it('the hook path collects the diagnostics with their codes instead of writing them', async () => {
    const diagnostics: SourceDiagnostics = [];
    const config: AppConfig = { plugins: { sources: { ghost: {} } } };
    const context = await resolveHookContextForSource('ghost', { session_id: 'x' }, config, { diagnostics });

    expect(context).toEqual({});
    expect(diagnostics).toEqual([
      {
        code: 'source-skipped',
        source: 'ghost',
        message: 'source skipped source=ghost reason=no-handler-or-match'
      }
    ]);
    expect(existsSync(logPath)).toBe(false);
  });

  it('the badge refresh path writes the line it always wrote', async () => {
    const sources = await billableSources({ plugins: { sources: { emptyagent: {} } } }, { includeHandlers: false });

    expect(sources.map((source) => source.id)).toContain('codex');
    expect(await readLog()).toContain('source skipped source=emptyagent reason=no-handler-or-match');
  });

  it('the source add validation writes the line it always wrote', async () => {
    const validation = await loadSourcePluginForValidation('no-such-package-xyz');

    expect(validation).toEqual({ ok: false, reason: 'package could not be resolved from the plugins dir' });
    expect(await readLog()).toContain('source refused source=no-such-package-xyz reason=specifier-unresolved');
  });
});

// A broken config entry of another source must not fail the hook's lookup, while a broken entry of the hook's own
// source — or a null root — keeps failing open as one `hook failed` record and exit 0. Any other non-object root
// reads as no user entries, and the hook records with the shipped default source.
describe('hook producer — broken config entries', () => {
  it('records the event when another source has a broken entry', async () => {
    await writeConfig({ plugins: { sources: { x: null } } } as unknown as AppConfig);

    await runHook(['--source', 'claude', '--event', 'SessionStart'], { session_id: 's1' });

    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'event', source: 'claude', sessionId: 's1' });
    expect(hookWorkerStarts.requested).toBe(1);
  });

  it('records with the shipped default source when the root is an array', async () => {
    await writeFile(join(homeDir, 'config.json'), '["not", "a", "table"]');

    await runHook(['--source', 'codex', '--event', 'SessionStart'], { session_id: 's1' });

    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'event', source: 'codex', sessionId: 's1' });
  });

  it("fails open on its own source's broken entry with one hook failed record and exit 0", async () => {
    await writeConfig({ plugins: { sources: { claude: null } } } as unknown as AppConfig);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runHook(['--source', 'claude', '--event', 'SessionStart'], { session_id: 's1' });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
    }

    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'error',
      code: 'hook-failed',
      message: expect.stringContaining('hook failed')
    });
  });

  it('fails open on a null config root with one hook failed record and exit 0', async () => {
    await writeFile(join(homeDir, 'config.json'), 'null');
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runHook(['--source', 'codex', '--event', 'SessionStart'], { session_id: 's1' });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
    }

    const records = await writtenRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'error', code: 'hook-failed' });
  });
});
