import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hook } from '../src/cli/commands/hook.js';
import { SCAN_ENV } from '../src/cli/hook-context.js';
import { createEmptyState, type AgentSession } from '../src/state.js';
import { loadState, saveState } from '../src/state-store.js';
import { captureHookWorkerStarts, drainQueue, restoreHookWorkerStarts } from './hook-producer-support.js';

// Pin the remaining invocation forms in docs/architecture.md, "Hook
// Normalization": internal names through `--source/--event`, and native
// opencode/Pi payloads through `--agent`. Each case records through the hook
// producer and applies through one in-process worker run (`drainQueue`). The
// seeded running sessions distinguish start from heartbeat by startedAt, and
// the usage badge assertions distinguish session boundaries from activity.

const publishValueMock = vi.hoisted(() => vi.fn<(value: string) => Promise<void>>());
const stdinPayload = vi.hoisted(() => ({ current: {} as unknown }));

vi.mock('../src/providers/registry.js', () => ({
  createProvider: () => ({
    id: 'feishu-signature',
    publishValue: publishValueMock
  })
}));

vi.mock('../src/secret.js', () => ({
  readCredential: vi
    .fn<typeof import('../src/secret.js').readCredential>()
    .mockResolvedValue({ token: 'test-token', slotId: 'test-slot' })
}));

vi.mock('../src/cli/io.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/io.js')>('../src/cli/io.js');
  return {
    ...actual,
    // The hook command reads its payload from stdin; cases inject it here.
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
// Movable clock: cases that drive several lifecycle steps
// advance it so a late heartbeat lands at a different timestamp than the
// session's start.
const clock = { now: NOW };

function advanceMs(ms: number): void {
  clock.now += ms;
}

// Environment the hook path reads (directly or through the resolvers and the
// usage scanners). Saved and cleared around every case so neither the real
// home nor a previous case's agent env can leak in.
const MANAGED_ENV_KEYS = [
  'HOME',
  'PWD',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'AGENT_PRESENCE_HOME',
  ...Object.values(SCAN_ENV),
  'AGENT_PRESENCE_LOG_FILE',
  'AGENT_SIGNATURE_LOG_FILE',
  'CLAUDE_HOOK_EVENT_NAME',
  'CLAUDE_SESSION_ID',
  'CLAUDE_TRANSCRIPT_PATH',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CMUX_SURFACE_ID',
  'GEMINI_HOOK_EVENT_NAME',
  'GEMINI_PROJECT_DIR',
  'GEMINI_SESSION_ID',
  'GROK_HOOK_EVENT',
  'GROK_SESSION_ID',
  'OPENCODE_CWD',
  'OPENCODE_HOOK_EVENT',
  'OPENCODE_PROJECT',
  'OPENCODE_SESSION_ID',
  'PI_CWD',
  'PI_EVENT',
  'PI_HOOK_EVENT',
  'PI_PROJECT',
  'PI_SESSION_ID'
];

let homeDir: string;
let stdoutWrites: string[];

function claudePayload(event: string, sessionId = 'claude-session-1', extra: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    transcript_path: `/fake-home/.claude/projects/-work-repo/${sessionId}.jsonl`,
    cwd: '/work/repo',
    hook_event_name: event,
    ...extra
  };
}

function codexPayload(sessionId = 'codex-thread-1', extra: Record<string, unknown> = {}) {
  return { thread_id: sessionId, cwd: '/work/repo', ...extra };
}

function geminiPayload(event: string) {
  return { session_id: 'gemini-session-1', cwd: '/work/repo', hook_event_name: event };
}

// Grok payloads carry the snake_case alias of the presence event name.
function toSnakeEvent(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
}

interface HookRun {
  source: string;
  /** Omitted to run without --event, so the source resolver names the event. */
  event?: string;
  payload: unknown;
  env?: Record<string, string>;
  /** Installed Codex hooks run without --silent; everything else is silent. */
  loud?: boolean;
}

async function runHookCommand(args: string[], payload: unknown, env: Record<string, string> = {}): Promise<void> {
  stdinPayload.current = payload;
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  stdoutWrites.length = 0;
  await hook(args);
  // The worker applies what the hook recorded before the case reads the state.
  await drainQueue();
}

async function runHook(run: HookRun): Promise<void> {
  const args = ['--source', run.source];
  if (run.event !== undefined) {
    args.push('--event', run.event);
  }
  if (!run.loud) {
    args.push('--silent');
  }
  await runHookCommand(args, run.payload, run.env);
}

async function runAgent(agent: string, payload: unknown): Promise<void> {
  await runHookCommand(['--agent', agent, '--silent'], payload);
}

// --- Shared fixtures ---------------------------------------------------------

function runningSession(source: string, id: string, project = '/work/repo'): AgentSession {
  return {
    id,
    source,
    kind: 'coding',
    status: 'running',
    startedAt: NOW - 60_000,
    lastHeartbeatAt: NOW - 30_000,
    project
  };
}

async function seedSessions(...sessions: AgentSession[]): Promise<void> {
  const state = createEmptyState();
  for (const session of sessions) {
    state.sessions[session.id] = session;
  }
  await saveState(state);
}

function finishedOverrides(): Partial<AgentSession> {
  return { status: 'finished', finishedAt: NOW - 20_000 };
}

/** Every billable built-in the boundary refresh scans for a zero-usage day. */
// Grok is billable now that its kit decoder is scanned with the others.
const BILLABLE_SOURCE_IDS = ['claude', 'codex', 'dsh', 'gemini', 'grok', 'opencode', 'pi'];

async function readState() {
  return loadState();
}

beforeEach(async () => {
  const previousEnv = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-hook-table-'));
  process.env.HOME = homeDir;
  process.env.AGENT_PRESENCE_HOME = homeDir;
  process.env.XDG_DATA_HOME = join(homeDir, 'xdg', 'data');
  process.env.XDG_CONFIG_HOME = join(homeDir, 'xdg', 'config');
  process.env.XDG_STATE_HOME = join(homeDir, 'xdg', 'state');
  await writeFile(
    join(homeDir, 'config.json'),
    JSON.stringify({
      usage: { showInSignature: true, signatureWindowDays: 1 }
    })
  );
  clock.now = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  captureHookWorkerStarts();
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Uint8Array | string) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  return async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    restoreHookWorkerStarts();
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  };
});

describe('hook event table — Claude Code', () => {
  const run = (event: string, payload: unknown, extra: Partial<HookRun> = {}) =>
    runHook({ source: 'claude', event, payload, ...extra });

  it('SessionStart creates a running session and refreshes the usage badge', async () => {
    await run('SessionStart', claudePayload('SessionStart'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({
      source: 'claude',
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW,
      project: '/work/repo'
    });
    expect(state.usageBadgesAt).toBe(NOW);
    expect(Object.keys(state.usageSnapshots?.['1'] ?? {}).sort()).toEqual(BILLABLE_SOURCE_IDS);
  });

  it('SessionStart restarts a running session (startedAt resets) and refreshes the usage badge', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('SessionStart', claudePayload('SessionStart'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('SessionStart with source compact restarts a running session (startedAt resets)', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('SessionStart', claudePayload('SessionStart', 'claude-session-1', { source: 'compact' }));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('UserPromptSubmit creates a session on an empty state without a badge refresh', async () => {
    await run('UserPromptSubmit', claudePayload('UserPromptSubmit'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({ status: 'running', startedAt: NOW });
    expect(state.usageBadgesAt).toBeUndefined();
    expect(state.usageSnapshots).toBeUndefined();
  });

  it('UserPromptSubmit reopens a finished session with a fresh startedAt', async () => {
    await seedSessions({ ...runningSession('claude', 'claude-session-1'), ...finishedOverrides() });
    await run('UserPromptSubmit', claudePayload('UserPromptSubmit'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      finishedAt: undefined
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('PreToolUse keeps a running session alive without resetting startedAt', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('PreToolUse', claudePayload('PreToolUse'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('PostToolUse keeps a running session alive without resetting startedAt', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('PostToolUse', claudePayload('PostToolUse'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('a finished session stays finished on an ordinary heartbeat', async () => {
    await seedSessions({ ...runningSession('claude', 'claude-session-1'), ...finishedOverrides() });
    await run('PreToolUse', claudePayload('PreToolUse'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'finished',
      finishedAt: NOW - 20_000,
      lastHeartbeatAt: NOW - 30_000
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('Stop finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('Stop', claudePayload('Stop'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'finished',
      finishedAt: NOW,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('Stop with an unknown session id finishes the latest matching running session', async () => {
    await seedSessions(runningSession('claude', 'claude-older', '/work/repo'), {
      ...runningSession('claude', 'claude-newer', '/work/repo'),
      lastHeartbeatAt: NOW - 10_000
    });
    await run('Stop', claudePayload('Stop', 'claude-untracked'));

    const state = await readState();
    expect(state.sessions['claude-newer']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.sessions['claude-older']).toMatchObject({ status: 'running' });
    expect(state.sessions['claude-untracked']).toBeUndefined();
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('Stop with no matching session creates nothing but still refreshes the badge', async () => {
    await run('Stop', claudePayload('Stop', 'claude-never-started'));

    const state = await readState();
    expect(state.sessions).toEqual({});
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('StopFailure finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('StopFailure', claudePayload('StopFailure'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('SessionEnd finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('SessionEnd', claudePayload('SessionEnd'));

    const state = await readState();
    expect(state.sessions['claude-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('SubagentStart tracks a separate session and skips the badge refresh', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('SubagentStart', claudePayload('SubagentStart', 'claude-session-1', { agent_id: 'agent-2' }));

    const state = await readState();
    expect(state.sessions['claude-session-1:subagent:agent-2']).toMatchObject({
      source: 'claude',
      status: 'running',
      startedAt: NOW
    });
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('SubagentStop finishes only the subagent session', async () => {
    await seedSessions(
      runningSession('claude', 'claude-session-1'),
      runningSession('claude', 'claude-session-1:subagent:agent-2')
    );
    await run('SubagentStop', claudePayload('SubagentStop', 'claude-session-1', { agent_id: 'agent-2' }));

    const state = await readState();
    expect(state.sessions['claude-session-1:subagent:agent-2']).toMatchObject({
      status: 'finished',
      finishedAt: NOW
    });
    expect(state.sessions['claude-session-1']).toMatchObject({ status: 'running' });
    expect(state.usageBadgesAt).toBeUndefined();
  });
});

describe('hook event table — Codex', () => {
  const run = (event: string, extra: Partial<HookRun> = {}) =>
    runHook({ source: 'codex', event, payload: codexPayload(), ...extra });

  it('SessionStart creates a running session and keeps the {} pass-through output', async () => {
    await run('SessionStart', { loud: true });

    expect(stdoutWrites).toEqual(['{}\n']);
    const state = await readState();
    expect(state.sessions['codex-thread-1']).toMatchObject({
      source: 'codex',
      status: 'running',
      startedAt: NOW,
      project: '/work/repo'
    });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('SessionStart with source compact restarts a running session (startedAt resets)', async () => {
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('SessionStart', { payload: codexPayload('codex-thread-1', { source: 'compact' }) });

    const state = await readState();
    expect(state.sessions['codex-thread-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('UserPromptSubmit reopens a finished session without a badge refresh', async () => {
    await seedSessions({ ...runningSession('codex', 'codex-thread-1'), ...finishedOverrides() });
    await run('UserPromptSubmit');

    const state = await readState();
    expect(state.sessions['codex-thread-1']).toMatchObject({ status: 'running', startedAt: NOW });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('PreToolUse keeps a running session alive', async () => {
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('PreToolUse');

    const state = await readState();
    expect(state.sessions['codex-thread-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('Stop finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('Stop');

    const state = await readState();
    expect(state.sessions['codex-thread-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });
});

describe('hook event table — Gemini CLI via --source/--event', () => {
  const run = (event: string) => runHook({ source: 'gemini', event, payload: geminiPayload(event) });

  it('SessionStart creates a running session and refreshes the usage badge', async () => {
    await run('SessionStart');

    const state = await readState();
    expect(state.sessions['gemini-session-1']).toMatchObject({
      source: 'gemini',
      status: 'running',
      startedAt: NOW,
      project: '/work/repo'
    });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('UserPromptSubmit reopens a finished session through the internal vocabulary', async () => {
    await seedSessions({ ...runningSession('gemini', 'gemini-session-1'), ...finishedOverrides() });
    await run('UserPromptSubmit');

    const state = await readState();
    expect(state.sessions['gemini-session-1']).toMatchObject({ status: 'running', startedAt: NOW });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('PreToolUse and PostToolUse keep a running session alive', async () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      await seedSessions(runningSession('gemini', 'gemini-session-1'));
      await run(event);

      const state = await readState();
      expect(state.sessions['gemini-session-1']).toMatchObject({
        status: 'running',
        startedAt: NOW - 60_000,
        lastHeartbeatAt: NOW
      });
      expect(state.usageBadgesAt).toBeUndefined();
    }
  });

  it('Stop finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('gemini', 'gemini-session-1'));
    await run('Stop');

    const state = await readState();
    expect(state.sessions['gemini-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('SessionEnd finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('gemini', 'gemini-session-1'));
    await run('SessionEnd');

    const state = await readState();
    expect(state.sessions['gemini-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });
});

describe('hook event table — opencode via --agent with kit bridge payloads', () => {
  const run = (type: string, properties: Record<string, unknown> = {}, currentSessionId?: string) =>
    runAgent('opencode', {
      type,
      properties,
      directory: '/work/repo',
      ...(currentSessionId === undefined ? {} : { currentSessionId })
    });

  it('session.created starts the session and refreshes the usage badge', async () => {
    await run('session.created', { info: { id: 'opencode-session-1', directory: '/work/repo' } });

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      source: 'opencode',
      status: 'running',
      startedAt: NOW,
      project: '/work/repo'
    });
    expect(state.usageBadgesAt).toBe(NOW);
    expect(Object.keys(state.usageSnapshots?.['1'] ?? {}).sort()).toEqual(BILLABLE_SOURCE_IDS);
  });

  it('session.created restarts a running session (startedAt resets)', async () => {
    await seedSessions(runningSession('opencode', 'opencode-session-1'));
    await run('session.created', { info: { id: 'opencode-session-1', directory: '/work/repo' } });

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it.each(['busy', 'retry'])('session.status %s stays a heartbeat without a badge refresh', async (type) => {
    await seedSessions(runningSession('opencode', 'opencode-session-1'));
    await run('session.status', { sessionID: 'opencode-session-1', status: { type } });

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('session.status idle finishes the session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('opencode', 'opencode-session-1'));
    await run('session.status', { sessionID: 'opencode-session-1', status: { type: 'idle' } });

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it.each([
    ['message.updated', { info: { id: 'msg_1', sessionID: 'opencode-session-1' } }],
    ['message.part.updated', { part: { id: 'prt_1', sessionID: 'opencode-session-1' } }],
    ['tool.execute.before', { tool: 'bash', sessionID: 'opencode-session-1', callID: 'call-1' }],
    ['tool.execute.after', { tool: 'bash', sessionID: 'opencode-session-1', callID: 'call-1', args: {} }],
    ['command.executed', { name: 'compact', sessionID: 'opencode-session-1', arguments: '', messageID: 'msg_1' }],
    ['todo.updated', { sessionID: 'opencode-session-1', todos: [] }],
    ['session.diff', { sessionID: 'opencode-session-1', diff: [] }],
    ['session.updated', { info: { id: 'opencode-session-1' } }],
    [
      'permission.asked',
      { id: 'perm-1', sessionID: 'opencode-session-1', permission: 'bash', patterns: [], metadata: {}, always: [] }
    ],
    ['permission.replied', { sessionID: 'opencode-session-1', permissionID: 'perm-1', response: 'once' }]
  ])('%s keeps the session alive', async (type, properties) => {
    await seedSessions(runningSession('opencode', 'opencode-session-1'));
    await run(type, properties);

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('file.edited keeps the bridge current session alive', async () => {
    await seedSessions(runningSession('opencode', 'opencode-session-1'));
    await run('file.edited', { file: '/work/repo/src/index.ts' }, 'opencode-session-1');

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it.each([
    ['session.idle', { sessionID: 'opencode-session-1' }],
    ['session.error', { sessionID: 'opencode-session-1' }],
    ['session.deleted', { info: { id: 'opencode-session-1' } }]
  ])('%s finishes the session and refreshes the usage badge', async (type, properties) => {
    await seedSessions(runningSession('opencode', 'opencode-session-1'));
    await run(type, properties);

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('a session.error without sessionID finishes the bridge current session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('opencode', 'opencode-session-1'));
    await run('session.error', { error: { name: 'UnknownError', data: { message: 'failed' } } }, 'opencode-session-1');

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('a finished session stays finished on message updates (no reopen path)', async () => {
    await seedSessions({ ...runningSession('opencode', 'opencode-session-1'), ...finishedOverrides() });
    await run('message.updated', { info: { id: 'msg_1', sessionID: 'opencode-session-1' } });

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      status: 'finished',
      finishedAt: NOW - 20_000,
      lastHeartbeatAt: NOW - 30_000
    });
    expect(state.usageBadgesAt).toBeUndefined();
    expect(await readFile(join(homeDir, 'agent-presence.log'), 'utf8')).toContain(
      'source=opencode event=Heartbeat hasSessionId=true'
    );
  });

  it('a late message updates its named session before the bridge current session', async () => {
    await run('session.created', { info: { id: 'ses_a', directory: '/work/repo' } });
    await run('session.created', { info: { id: 'ses_b', directory: '/work/repo' } });

    advanceMs(5_000);
    await run('message.updated', { info: { id: 'msg_1', sessionID: 'ses_a' } }, 'ses_b');

    const state = await readState();
    expect(state.sessions['ses_a']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW + 5_000
    });
    expect(state.sessions['ses_b']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBe(NOW);
  });
});

describe('hook event table — Pi via --agent with kit bridge payloads', () => {
  const runPi = (type: string) => runAgent('pi', { type, sessionId: 'pi-session-1', cwd: '/work/repo' });

  it('before_agent_start (SessionStart) starts the session and refreshes the usage badge', async () => {
    await runPi('before_agent_start');

    const state = await readState();
    expect(state.sessions['pi-session-1']).toMatchObject({
      source: 'pi',
      status: 'running',
      startedAt: NOW,
      project: '/work/repo'
    });
    expect(state.usageBadgesAt).toBe(NOW);
    expect(Object.keys(state.usageSnapshots?.['1'] ?? {}).sort()).toEqual(BILLABLE_SOURCE_IDS);
  });

  it('session_start is ignored and opening Pi creates no session', async () => {
    await runPi('session_start');

    const state = await readState();
    expect(state.sessions).toEqual({});
    expect(state.usageBadgesAt).toBeUndefined();
    expect(await readFile(join(homeDir, 'agent-presence.log'), 'utf8')).toContain(
      'hook skipped: ignored event source=pi event=session_start'
    );
  });

  it.each(['turn_start', 'tool_execution_start', 'tool_execution_end'])(
    '%s (Heartbeat) keeps the session alive',
    async (name) => {
      await seedSessions(runningSession('pi', 'pi-session-1'));
      await runPi(name);

      const state = await readState();
      expect(state.sessions['pi-session-1']).toMatchObject({
        status: 'running',
        startedAt: NOW - 60_000,
        lastHeartbeatAt: NOW
      });
      expect(state.usageBadgesAt).toBeUndefined();
    }
  );

  it.each(['agent_end', 'session_shutdown'])(
    '%s (Stop) finishes the running session and refreshes the usage badge',
    async (name) => {
      await seedSessions(runningSession('pi', 'pi-session-1'));
      await runPi(name);

      const state = await readState();
      expect(state.sessions['pi-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
      expect(state.usageBadgesAt).toBe(NOW);
    }
  );

  it('a finished session stays finished on turn activity', async () => {
    await seedSessions({ ...runningSession('pi', 'pi-session-1'), ...finishedOverrides() });
    await runPi('turn_start');

    const state = await readState();
    expect(state.sessions['pi-session-1']).toMatchObject({
      status: 'finished',
      finishedAt: NOW - 20_000,
      lastHeartbeatAt: NOW - 30_000
    });
    expect(state.usageBadgesAt).toBeUndefined();
    expect(await readFile(join(homeDir, 'agent-presence.log'), 'utf8')).toContain(
      'source=pi event=Heartbeat hasSessionId=true'
    );
  });
});

describe('hook event table — Grok (driven via --event, presence-only source)', () => {
  const run = (event: string, extra: Record<string, unknown> = {}) =>
    runHook({
      source: 'grok',
      event,
      payload: { hookEventName: toSnakeEvent(event), sessionId: 'grok-session-1', cwd: '/work/repo', ...extra }
    });

  it('session_start (SessionStart) creates a running session and refreshes the usage badge', async () => {
    await run('SessionStart');

    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({
      source: 'grok',
      status: 'running',
      startedAt: NOW,
      project: '/work/repo'
    });
    expect(state.usageBadgesAt).toBe(NOW);
    // The boundary scans the billable built-ins; grok is not among them yet.
    // The grok boundary refresh now owns the grok source like any other built-in.
    expect(Object.keys(state.usageSnapshots?.['1'] ?? {})).toContain('grok');
  });

  it('user_prompt_submit (UserPromptSubmit) reopens a finished session without a badge refresh', async () => {
    await seedSessions({ ...runningSession('grok', 'grok-session-1'), ...finishedOverrides() });
    await run('UserPromptSubmit');

    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      finishedAt: undefined
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('pre_tool_use (PreToolUse) keeps a running session alive', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('PreToolUse');

    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('post_tool_use (PostToolUse) keeps a running session alive without resetting startedAt', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('PostToolUse');

    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it.each([
    ['end_turn', { reason: 'end_turn' }],
    ['channel_closed', { reason: 'channel_closed' }],
    ['shutdown', { reason: 'shutdown' }],
    ['no reason', {}]
  ])('stop (%s) finishes the running session and refreshes the usage badge', async (_name, extra) => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('Stop', extra);

    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('stop_failure (StopFailure) finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('StopFailure');

    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('session_end (SessionEnd) finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('SessionEnd');

    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('subagent_start (SubagentStart) tracks a separate session by subagentId', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('SubagentStart', { subagentId: 'sub-1' });

    const state = await readState();
    expect(state.sessions['grok-session-1:subagent:sub-1']).toMatchObject({
      source: 'grok',
      status: 'running',
      startedAt: NOW
    });
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'running', startedAt: NOW - 60_000 });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('subagent_start (SubagentStart) falls back to subagentType for the session key', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('SubagentStart', { subagentType: 'explorer' });

    const state = await readState();
    expect(state.sessions['grok-session-1:subagent:explorer']).toMatchObject({ status: 'running', startedAt: NOW });
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'running' });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('subagent_stop (SubagentStop) finishes only the subagent session', async () => {
    await seedSessions(
      runningSession('grok', 'grok-session-1'),
      runningSession('grok', 'grok-session-1:subagent:sub-1')
    );
    await run('SubagentStop', { subagentId: 'sub-1' });

    const state = await readState();
    expect(state.sessions['grok-session-1:subagent:sub-1']).toMatchObject({
      status: 'finished',
      finishedAt: NOW
    });
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'running' });
    expect(state.usageBadgesAt).toBeUndefined();
  });
});

describe('hook --source grok without --event', () => {
  const run = (hookEventName: string, extra: Record<string, unknown> = {}) =>
    runHook({
      source: 'grok',
      payload: { hookEventName, sessionId: 'grok-session-1', cwd: '/work/repo', ...extra }
    });

  it('stop finishes the running session and refreshes the usage badge', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('stop', { reason: 'end_turn' });

    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('subagent_stop finishes only the subagent session', async () => {
    await seedSessions(
      runningSession('grok', 'grok-session-1'),
      runningSession('grok', 'grok-session-1:subagent:sub-1')
    );
    await run('subagent_stop', { subagentId: 'sub-1' });

    const state = await readState();
    expect(state.sessions['grok-session-1:subagent:sub-1']).toMatchObject({
      status: 'finished',
      finishedAt: NOW
    });
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'running' });
    expect(state.usageBadgesAt).toBeUndefined();
  });
});
