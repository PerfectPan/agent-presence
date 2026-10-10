import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinHookDialects } from '@rivus/agent-kit/harness/events';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hook } from '../src/cli/commands/hook.js';
import { createEmptyState, loadState, saveState, type AgentSession, type PresenceState } from '../src/state.js';

// `hook --agent <kitAgentId>` interpreted with readHookEvent. One case per row of
// Plan 0002 §3.4, including grouped names and payload branches. Where a
// today-rule exists, the state outcome matches test/hook-event-table.test.ts.

const publishValueMock = vi.hoisted(() => vi.fn<(value: string) => Promise<void>>());
const stdinPayload = vi.hoisted(() => {
  const box: { current: unknown } = { current: {} };
  return box;
});

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
    readStdinJson: async () => stdinPayload.current
  };
});

vi.mock('../src/cli/deferred-update.js', () => ({
  scheduleDeferredRenderedUpdate: async () => undefined,
  scheduleDeferredRenderedUpdateForResult: async () => undefined
}));

const NOW = new Date(2026, 9, 9, 15, 0).getTime();

const MANAGED_ENV_KEYS = [
  'HOME',
  'PWD',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'AGENT_PRESENCE_HOME',
  'AGENT_PRESENCE_LOG_FILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_HOOK_EVENT_NAME',
  'CLAUDE_SESSION_ID',
  'CLAUDE_TRANSCRIPT_PATH',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CURSOR_VERSION',
  'CMUX_SURFACE_ID',
  'GEMINI_CLI_HOME',
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

const BILLABLE_SOURCE_IDS = ['claude', 'codex', 'dsh', 'gemini', 'opencode', 'pi'];

function claudePayload(event: string, sessionId = 'claude-session-1', extra: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    transcript_path: `/fake-home/.claude/projects/-work-repo/${sessionId}.jsonl`,
    cwd: '/work/repo',
    hook_event_name: event,
    ...extra
  };
}

function codexPayload(event: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: event,
    thread_id: 'codex-thread-1',
    session_id: 'codex-thread-1',
    cwd: '/work/repo',
    ...extra
  };
}

function geminiPayload(event: string) {
  return { session_id: 'gemini-session-1', cwd: '/work/repo', hook_event_name: event };
}

function grokPayload(event: string, extra: Record<string, unknown> = {}) {
  return { hookEventName: event, sessionId: 'grok-session-1', cwd: '/work/repo', ...extra };
}

function openCodeBus(type: string, properties: Record<string, unknown>) {
  return { type, properties, directory: '/work/repo' };
}

function piPayload(type: string) {
  return { type, sessionId: 'pi-session-1', cwd: '/work/repo' };
}

interface AgentRun {
  agent: string;
  payload: unknown;
  loud?: boolean;
  env?: Record<string, string>;
}

async function runAgent(run: AgentRun): Promise<void> {
  stdinPayload.current = run.payload;
  for (const [key, value] of Object.entries(run.env ?? {})) {
    process.env[key] = value;
  }
  stdoutWrites.length = 0;
  const args = ['--agent', run.agent];
  if (!run.loud) {
    args.push('--silent');
  }
  await hook(args);
}

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

async function readState(): Promise<PresenceState> {
  return loadState();
}

async function readLog(): Promise<string> {
  try {
    return await readFile(join(homeDir, 'agent-presence.log'), 'utf8');
  } catch {
    return '';
  }
}

function keptView(state: PresenceState, id: string) {
  const session = state.sessions[id];
  return {
    source: session?.source,
    status: session?.status,
    startedAt: session?.startedAt,
    lastHeartbeatAt: session?.lastHeartbeatAt,
    usageBadgesAt: state.usageBadgesAt
  };
}

function runningKept(source: string) {
  return {
    source,
    status: 'running',
    startedAt: NOW - 60_000,
    lastHeartbeatAt: NOW,
    usageBadgesAt: undefined
  };
}

function startedView(state: PresenceState, id: string) {
  const session = state.sessions[id];
  return {
    source: session?.source,
    status: session?.status,
    startedAt: session?.startedAt,
    lastHeartbeatAt: session?.lastHeartbeatAt,
    project: session?.project,
    usageBadgesAt: state.usageBadgesAt
  };
}

function startedExpected(source: string) {
  return {
    source,
    status: 'running',
    startedAt: NOW,
    lastHeartbeatAt: NOW,
    project: '/work/repo',
    usageBadgesAt: NOW
  };
}

function finishedView(state: PresenceState, id: string) {
  const session = state.sessions[id];
  return {
    status: session?.status,
    finishedAt: session?.finishedAt,
    lastHeartbeatAt: session?.lastHeartbeatAt,
    usageBadgesAt: state.usageBadgesAt
  };
}

function finishedExpected() {
  return {
    status: 'finished',
    finishedAt: NOW,
    lastHeartbeatAt: NOW,
    usageBadgesAt: NOW
  };
}

function settledView(state: PresenceState, id: string) {
  const session = state.sessions[id];
  return {
    keys: Object.keys(state.sessions),
    source: session?.source,
    status: session?.status,
    startedAt: session?.startedAt,
    lastHeartbeatAt: session?.lastHeartbeatAt,
    finishedAt: session?.finishedAt,
    usageBadgesAt: state.usageBadgesAt
  };
}

function finishedSettled(source: string, id: string) {
  return {
    keys: [id],
    source,
    status: 'finished',
    startedAt: NOW - 60_000,
    lastHeartbeatAt: NOW - 30_000,
    finishedAt: NOW - 20_000,
    usageBadgesAt: undefined
  };
}

function untouchedRunning(source: string, id: string) {
  return {
    keys: [id],
    source,
    status: 'running',
    startedAt: NOW - 60_000,
    lastHeartbeatAt: NOW - 30_000,
    finishedAt: undefined,
    usageBadgesAt: undefined
  };
}

beforeEach(async () => {
  const previousEnv = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-hook-agent-'));
  process.env.HOME = homeDir;
  process.env.AGENT_PRESENCE_HOME = homeDir;
  process.env.XDG_DATA_HOME = join(homeDir, 'xdg', 'data');
  process.env.XDG_CONFIG_HOME = join(homeDir, 'xdg', 'config');
  process.env.XDG_STATE_HOME = join(homeDir, 'xdg', 'state');
  await writeFile(
    join(homeDir, 'config.json'),
    JSON.stringify({ usage: { showInSignature: true, signatureWindowDays: 1 } })
  );
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
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
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  };
});

describe('hook --agent claude-code', () => {
  const run = (event: string, extra: Record<string, unknown> = {}) =>
    runAgent({ agent: 'claude-code', payload: claudePayload(event, 'claude-session-1', extra) });

  it('SessionStart creates a running session and refreshes the usage badge', async () => {
    await run('SessionStart');
    const state = await readState();
    expect(startedView(state, 'claude-session-1')).toEqual(startedExpected('claude'));
    expect(Object.keys(state.usageSnapshots?.['1'] ?? {}).sort()).toEqual(BILLABLE_SOURCE_IDS);
  });

  it('SessionStart restarts a running session, including a compact payload', async () => {
    for (const extra of [{}, { source: 'compact' }]) {
      await seedSessions(runningSession('claude', 'claude-session-1'));
      await run('SessionStart', extra);
      const state = await readState();
      expect(state.sessions['claude-session-1']).toMatchObject({ status: 'running', startedAt: NOW });
      expect(state.usageBadgesAt).toBe(NOW);
    }
  });

  it('UserPromptSubmit reopens a finished session without a badge refresh or a second session', async () => {
    await seedSessions({ ...runningSession('claude', 'claude-session-1'), ...finishedOverrides() });
    await run('UserPromptSubmit');
    const state = await readState();
    expect(Object.keys(state.sessions)).toEqual(['claude-session-1']);
    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      finishedAt: undefined
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('UserPromptSubmit keeps a running session’s startedAt', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('UserPromptSubmit');
    expect(keptView(await readState(), 'claude-session-1')).toEqual(runningKept('claude'));
  });

  it('PreToolUse keeps a running session alive', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('PreToolUse');
    expect(keptView(await readState(), 'claude-session-1')).toEqual(runningKept('claude'));
  });

  it('PreToolUse does not reopen a finished session', async () => {
    await seedSessions({ ...runningSession('claude', 'claude-session-1'), ...finishedOverrides() });
    await run('PreToolUse');
    expect(settledView(await readState(), 'claude-session-1')).toEqual(finishedSettled('claude', 'claude-session-1'));
  });

  it('PostToolUse keeps a running session alive', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('PostToolUse');
    expect(keptView(await readState(), 'claude-session-1')).toEqual(runningKept('claude'));
  });

  it('Stop finishes the running session', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('Stop');
    expect(finishedView(await readState(), 'claude-session-1')).toEqual(finishedExpected());
  });

  it('StopFailure finishes the running session', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('StopFailure');
    expect(finishedView(await readState(), 'claude-session-1')).toEqual(finishedExpected());
  });

  it('SessionEnd finishes the running session', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('SessionEnd');
    expect(finishedView(await readState(), 'claude-session-1')).toEqual(finishedExpected());
  });

  it('SubagentStart tracks a separate session and skips the badge refresh', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('SubagentStart', { agent_id: 'agent-2' });
    const state = await readState();
    expect(state.sessions['claude-session-1:subagent:agent-2']).toMatchObject({
      source: 'claude',
      status: 'running',
      startedAt: NOW
    });
    expect(state.sessions['claude-session-1']).toMatchObject({ status: 'running', startedAt: NOW - 60_000 });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('SubagentStop finishes only the subagent session', async () => {
    await seedSessions(
      runningSession('claude', 'claude-session-1'),
      runningSession('claude', 'claude-session-1:subagent:agent-2')
    );
    await run('SubagentStop', { agent_id: 'agent-2' });
    const state = await readState();
    expect(state.sessions['claude-session-1:subagent:agent-2']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.sessions['claude-session-1']).toMatchObject({ status: 'running' });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('maps an unlisted Notification from the kit phase', async () => {
    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('Notification', { notification_type: 'permission_prompt' });
    expect(keptView(await readState(), 'claude-session-1')).toEqual(runningKept('claude'));

    await seedSessions(runningSession('claude', 'claude-session-1'));
    await run('Notification', { notification_type: 'idle_prompt' });
    expect(finishedView(await readState(), 'claude-session-1')).toEqual(finishedExpected());
  });
});

describe('hook --agent codex', () => {
  const run = (event: string, extra: Record<string, unknown> = {}, loud = false) =>
    runAgent({ agent: 'codex', payload: codexPayload(event, extra), loud });

  it('SessionStart creates a running session and refreshes the usage badge', async () => {
    await run('SessionStart');
    expect(startedView(await readState(), 'codex-thread-1')).toEqual(startedExpected('codex'));
  });

  it('a compact SessionStart still restarts the running session', async () => {
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('SessionStart', { source: 'compact' });
    const state = await readState();
    expect(state.sessions['codex-thread-1']).toMatchObject({ status: 'running', startedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  });

  it('UserPromptSubmit reopens a finished session without a badge refresh', async () => {
    await seedSessions({ ...runningSession('codex', 'codex-thread-1'), ...finishedOverrides() });
    await run('UserPromptSubmit');
    const state = await readState();
    expect(Object.keys(state.sessions)).toEqual(['codex-thread-1']);
    expect(state.sessions['codex-thread-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      finishedAt: undefined
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('UserPromptSubmit keeps a running session’s startedAt', async () => {
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('UserPromptSubmit');
    expect(keptView(await readState(), 'codex-thread-1')).toEqual(runningKept('codex'));
    // The old hook ignores --agent and records event=Heartbeat. The interpreted name is the difference.
    expect(await readLog()).toContain('event=UserPromptSubmit');
  });

  it('PreToolUse keeps a running session alive', async () => {
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('PreToolUse');
    expect(keptView(await readState(), 'codex-thread-1')).toEqual(runningKept('codex'));
    expect(await readLog()).toContain('event=PreToolUse');
  });

  it('PreToolUse does not reopen a finished session', async () => {
    await seedSessions({ ...runningSession('codex', 'codex-thread-1'), ...finishedOverrides() });
    await run('PreToolUse');
    expect(settledView(await readState(), 'codex-thread-1')).toEqual(finishedSettled('codex', 'codex-thread-1'));
  });

  it('Stop finishes the running session', async () => {
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('Stop');
    expect(finishedView(await readState(), 'codex-thread-1')).toEqual(finishedExpected());
  });

  it('prints {} for a successful and a failing SessionStart and UserPromptSubmit, and nothing with --silent', async () => {
    expect(builtinHookDialects.codex.events.SessionStart?.output?.passThrough).toBe('');
    expect(builtinHookDialects.codex.events.UserPromptSubmit?.output?.passThrough).toBe('');

    await run('SessionStart', {}, true);
    expect(stdoutWrites).toEqual(['{}\n']);
    expect(startedView(await readState(), 'codex-thread-1')).toEqual(startedExpected('codex'));

    await seedSessions({ ...runningSession('codex', 'codex-thread-1'), ...finishedOverrides() });
    await run('UserPromptSubmit', {}, true);
    expect(stdoutWrites).toEqual(['{}\n']);
    expect((await readState()).sessions['codex-thread-1']).toMatchObject({ status: 'running', startedAt: NOW });

    publishValueMock.mockRejectedValue(new Error('publish failed'));
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('SessionStart', {}, true);
    expect(stdoutWrites).toEqual(['{}\n']);
    expect(await readLog()).toContain('hook failed:');
    expect((await readState()).usageBadgesAt).toBe(NOW);

    await seedSessions({ ...runningSession('codex', 'codex-thread-1'), ...finishedOverrides() });
    await run('UserPromptSubmit', {}, true);
    expect(stdoutWrites).toEqual(['{}\n']);
    expect((await readState()).sessions['codex-thread-1']).toMatchObject({ status: 'running', startedAt: NOW });

    publishValueMock.mockResolvedValue(undefined);
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('SessionStart');
    expect(stdoutWrites).toEqual([]);

    publishValueMock.mockRejectedValue(new Error('publish failed'));
    await seedSessions(runningSession('codex', 'codex-thread-1'));
    await run('UserPromptSubmit');
    expect(stdoutWrites).toEqual([]);
    expect(await readLog()).toContain('hook failed:');
  });
});

describe('hook --agent gemini-cli', () => {
  const run = (event: string) => runAgent({ agent: 'gemini-cli', payload: geminiPayload(event) });

  it('SessionStart creates a running session and refreshes the usage badge', async () => {
    await run('SessionStart');
    expect(startedView(await readState(), 'gemini-session-1')).toEqual(startedExpected('gemini'));
  });

  it('SessionEnd finishes the running session', async () => {
    await seedSessions(runningSession('gemini', 'gemini-session-1'));
    await run('SessionEnd');
    expect(finishedView(await readState(), 'gemini-session-1')).toEqual(finishedExpected());
  });

  it('keeps today’s signal for the four names Gemini never dispatched', async () => {
    await seedSessions({ ...runningSession('gemini', 'gemini-session-1'), ...finishedOverrides() });
    await run('UserPromptSubmit');
    const reopened = await readState();
    expect(reopened.sessions['gemini-session-1']).toMatchObject({ status: 'running', startedAt: NOW });
    expect(reopened.usageBadgesAt).toBeUndefined();

    for (const event of ['PreToolUse', 'PostToolUse']) {
      await seedSessions(runningSession('gemini', 'gemini-session-1'));
      await run(event);
      expect(keptView(await readState(), 'gemini-session-1')).toEqual(runningKept('gemini'));
    }

    await seedSessions(runningSession('gemini', 'gemini-session-1'));
    await run('Stop');
    expect(finishedView(await readState(), 'gemini-session-1')).toEqual(finishedExpected());
  });

  it('BeforeAgent starts a session', async () => {
    await run('BeforeAgent');
    expect(startedView(await readState(), 'gemini-session-1')).toEqual(startedExpected('gemini'));
  });

  it('BeforeTool and AfterTool keep a running session alive', async () => {
    for (const event of ['BeforeTool', 'AfterTool']) {
      await seedSessions(runningSession('gemini', 'gemini-session-1'));
      await run(event);
      expect(keptView(await readState(), 'gemini-session-1')).toEqual(runningKept('gemini'));
    }
  });

  it('AfterAgent finishes the running session', async () => {
    await seedSessions(runningSession('gemini', 'gemini-session-1'));
    await run('AfterAgent');
    expect(finishedView(await readState(), 'gemini-session-1')).toEqual(finishedExpected());
  });
});

describe('hook --agent opencode', () => {
  const session = 'opencode-session-1';
  const run = (type: string, properties: Record<string, unknown>) =>
    runAgent({ agent: 'opencode', payload: openCodeBus(type, properties) });

  it('session.created starts the session and refreshes the usage badge', async () => {
    await run('session.created', { info: { id: session } });
    expect(startedView(await readState(), session)).toEqual(startedExpected('opencode'));
  });

  it.each(['busy', 'retry'])('session.status %s stays a heartbeat', async (status) => {
    await seedSessions(runningSession('opencode', session));
    await run('session.status', { sessionID: session, status: { type: status } });
    expect(keptView(await readState(), session)).toEqual(runningKept('opencode'));
  });

  it('session.status idle finishes the session', async () => {
    await seedSessions(runningSession('opencode', session));
    await run('session.status', { sessionID: session, status: { type: 'idle' } });
    expect(finishedView(await readState(), session)).toEqual(finishedExpected());
  });

  it('message updates keep the session alive', async () => {
    await seedSessions(runningSession('opencode', session));
    await runAgent({
      agent: 'opencode',
      payload: openCodeBus('message.updated', { info: { id: 'msg_1', sessionID: session } })
    });
    expect(keptView(await readState(), session)).toEqual(runningKept('opencode'));

    await seedSessions(runningSession('opencode', session));
    await runAgent({
      agent: 'opencode',
      payload: openCodeBus('message.part.updated', { part: { id: 'prt_1', sessionID: session } })
    });
    expect(keptView(await readState(), session)).toEqual(runningKept('opencode'));
  });

  it.each([
    ['tool.execute.before', { tool: 'bash', sessionID: session, callID: 'call-1' }],
    ['tool.execute.after', { tool: 'bash', sessionID: session, callID: 'call-1', args: {} }]
  ])('%s keeps the session alive', async (type, properties) => {
    await seedSessions(runningSession('opencode', session));
    await run(type, properties);
    expect(keptView(await readState(), session)).toEqual(runningKept('opencode'));
  });

  it.each([
    ['command.executed', { name: 'compact', sessionID: session, arguments: '', messageID: 'msg_1' }],
    ['todo.updated', { sessionID: session, todos: [] }],
    ['session.diff', { sessionID: session, diff: [] }],
    ['session.updated', { info: { id: session } }],
    [
      'permission.asked',
      { id: 'perm-1', sessionID: session, permission: 'bash', patterns: [], metadata: {}, always: [] }
    ],
    ['permission.replied', { sessionID: session, permissionID: 'perm-1', response: 'once' }]
  ])('%s keeps the session alive', async (type, properties) => {
    await seedSessions(runningSession('opencode', session));
    await run(type, properties);
    expect(keptView(await readState(), session)).toEqual(runningKept('opencode'));
  });

  it('command.executed does not reopen a finished session', async () => {
    await seedSessions({ ...runningSession('opencode', session), ...finishedOverrides() });
    await run('command.executed', { name: 'compact', sessionID: session, arguments: '', messageID: 'msg_1' });
    expect(settledView(await readState(), session)).toEqual(finishedSettled('opencode', session));
  });

  it('permission.updated becomes a heartbeat and can create an absent session', async () => {
    await run('permission.updated', {
      id: 'perm-1',
      type: 'bash',
      sessionID: session,
      messageID: 'msg_1',
      title: 'bash',
      metadata: {},
      time: { created: 0 }
    });
    const created = await readState();
    expect(created.sessions[session]).toMatchObject({ status: 'running', startedAt: NOW });
    expect(created.usageBadgesAt).toBeUndefined();

    await seedSessions(runningSession('opencode', session));
    await run('permission.updated', {
      id: 'perm-1',
      type: 'bash',
      sessionID: session,
      messageID: 'msg_1',
      title: 'bash',
      metadata: {},
      time: { created: 0 }
    });
    expect(keptView(await readState(), session)).toEqual(runningKept('opencode'));
  });

  it.each([
    ['session.idle', { sessionID: session }],
    ['session.error', { sessionID: session }]
  ])('%s finishes the session', async (type, properties) => {
    await seedSessions(runningSession('opencode', session));
    await run(type, properties);
    expect(finishedView(await readState(), session)).toEqual(finishedExpected());
  });

  it('session.deleted finishes the session', async () => {
    await seedSessions(runningSession('opencode', session));
    await run('session.deleted', { info: { id: session } });
    expect(finishedView(await readState(), session)).toEqual(finishedExpected());
  });

  it('file.edited has no session id and is skipped', async () => {
    await seedSessions(runningSession('opencode', session));
    // agent-kit#86: the kit bridge forwards the bus event plus directory and does not remember OPENCODE_SESSION_ID.
    await run('file.edited', { file: '/work/repo/src/index.ts' });
    expect(settledView(await readState(), session)).toEqual(untouchedRunning('opencode', session));
    expect(await readLog()).toContain('hook skipped: missing session id for source=opencode event=Heartbeat');
  });

  it('session.error without sessionID is skipped', async () => {
    await seedSessions(runningSession('opencode', session));
    // agent-kit#86: session.error.sessionID is optional, and the kit bridge does not remember OPENCODE_SESSION_ID.
    await run('session.error', { error: { name: 'UnknownError', data: { message: 'failed' } } });
    expect(settledView(await readState(), session)).toEqual(untouchedRunning('opencode', session));
    expect(await readLog()).toContain('hook skipped: missing session id for source=opencode event=Stop');
  });

  it.each([
    ['session.compacted', { sessionID: session }],
    ['question.asked', { id: 'q-1', sessionID: session, questions: [] }],
    ['question.replied', { sessionID: session, requestID: 'q-1', answers: [] }],
    ['question.rejected', { sessionID: session, requestID: 'q-1' }]
  ])('%s is a heartbeat from the kit phase', async (type, properties) => {
    await seedSessions(runningSession('opencode', session));
    await run(type, properties);
    expect(keptView(await readState(), session)).toEqual(runningKept('opencode'));
  });
});

describe('hook --agent pi', () => {
  const run = (type: string) => runAgent({ agent: 'pi', payload: piPayload(type) });

  it('before_agent_start starts the session and refreshes the usage badge', async () => {
    await run('before_agent_start');
    expect(startedView(await readState(), 'pi-session-1')).toEqual(startedExpected('pi'));
  });

  it('session_start is ignored on an empty state and on a running session', async () => {
    await run('session_start');
    expect((await readState()).sessions).toEqual({});
    expect(await readLog()).toContain('hook skipped: ignored event source=pi event=session_start');

    await seedSessions(runningSession('pi', 'pi-session-1'));
    await run('session_start');
    const state = await readState();
    expect(state.sessions['pi-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW - 60_000,
      lastHeartbeatAt: NOW - 30_000
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it.each(['turn_start', 'tool_execution_start', 'tool_execution_end'])('%s keeps the session alive', async (type) => {
    await seedSessions(runningSession('pi', 'pi-session-1'));
    await run(type);
    expect(keptView(await readState(), 'pi-session-1')).toEqual(runningKept('pi'));
  });

  it.each(['agent_end', 'session_shutdown'])('%s finishes the running session', async (type) => {
    await seedSessions(runningSession('pi', 'pi-session-1'));
    await run(type);
    expect(finishedView(await readState(), 'pi-session-1')).toEqual(finishedExpected());
  });

  it('agent_start starts a session and agent_settled finishes it', async () => {
    await run('agent_start');
    expect(startedView(await readState(), 'pi-session-1')).toEqual(startedExpected('pi'));
    await run('agent_settled');
    expect(finishedView(await readState(), 'pi-session-1')).toEqual(finishedExpected());
  });

  it.each(['turn_end', 'tool_call', 'session_compact', 'ui_prompt_start', 'ui_prompt_end'])(
    '%s stays a heartbeat',
    async (type) => {
      await seedSessions(runningSession('pi', 'pi-session-1'));
      await run(type);
      expect(keptView(await readState(), 'pi-session-1')).toEqual(runningKept('pi'));
    }
  );

  it('stays running across a multi-turn sequence until agent_end', async () => {
    await run('before_agent_start');
    expect(startedView(await readState(), 'pi-session-1')).toEqual(startedExpected('pi'));

    for (const type of ['turn_end', 'turn_start', 'tool_execution_start', 'tool_call', 'tool_execution_end']) {
      await run(type);
      const state = await readState();
      expect(state.sessions['pi-session-1']).toMatchObject({
        status: 'running',
        startedAt: NOW,
        lastHeartbeatAt: NOW
      });
    }

    await run('agent_end');
    expect(finishedView(await readState(), 'pi-session-1')).toEqual(finishedExpected());
  });
});

describe('hook --agent grok', () => {
  const run = (event: string, extra: Record<string, unknown> = {}) =>
    runAgent({ agent: 'grok', payload: grokPayload(event, extra) });

  it('session_start creates a running session and refreshes the usage badge', async () => {
    await run('session_start');
    const state = await readState();
    expect(startedView(state, 'grok-session-1')).toEqual(startedExpected('grok'));
    expect(Object.keys(state.usageSnapshots?.['1'] ?? {})).not.toContain('grok');
  });

  it('user_prompt_submit reopens a finished session without a badge refresh', async () => {
    await seedSessions({ ...runningSession('grok', 'grok-session-1'), ...finishedOverrides() });
    await run('user_prompt_submit');
    const state = await readState();
    expect(Object.keys(state.sessions)).toEqual(['grok-session-1']);
    expect(state.sessions['grok-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      finishedAt: undefined
    });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('a PascalCase UserPromptSubmit spelling is the same reopen', async () => {
    await seedSessions({ ...runningSession('grok', 'grok-session-1'), ...finishedOverrides() });
    await run('UserPromptSubmit');
    const state = await readState();
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'running', startedAt: NOW });
    expect(state.usageBadgesAt).toBeUndefined();
  });

  it('user_prompt_submit keeps a running session’s startedAt', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('user_prompt_submit');
    expect(keptView(await readState(), 'grok-session-1')).toEqual(runningKept('grok'));
  });

  it('pre_tool_use keeps a running session alive', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('pre_tool_use');
    expect(keptView(await readState(), 'grok-session-1')).toEqual(runningKept('grok'));
  });

  it('pre_tool_use does not reopen a finished session', async () => {
    await seedSessions({ ...runningSession('grok', 'grok-session-1'), ...finishedOverrides() });
    await run('pre_tool_use');
    expect(settledView(await readState(), 'grok-session-1')).toEqual(finishedSettled('grok', 'grok-session-1'));
  });

  it('post_tool_use keeps a running session alive', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('post_tool_use');
    expect(keptView(await readState(), 'grok-session-1')).toEqual(runningKept('grok'));
  });

  it.each([
    ['end_turn', { reason: 'end_turn' }],
    ['channel_closed', { reason: 'channel_closed' }],
    ['shutdown', { reason: 'shutdown' }],
    ['no reason', {}]
  ])('stop (%s) finishes the running session', async (_name, extra) => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('stop', extra);
    expect(finishedView(await readState(), 'grok-session-1')).toEqual(finishedExpected());
  });

  it('stop_failure finishes the running session', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('stop_failure');
    expect(finishedView(await readState(), 'grok-session-1')).toEqual(finishedExpected());
  });

  it('session_end finishes the running session', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('session_end');
    expect(finishedView(await readState(), 'grok-session-1')).toEqual(finishedExpected());
  });

  it('subagent_start tracks subagentId, then subagentType', async () => {
    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('subagent_start', { subagentId: 'sub-1' });
    const byId = await readState();
    expect(byId.sessions['grok-session-1:subagent:sub-1']).toMatchObject({
      source: 'grok',
      status: 'running',
      startedAt: NOW
    });
    expect(byId.usageBadgesAt).toBeUndefined();

    await seedSessions(runningSession('grok', 'grok-session-1'));
    await run('subagent_start', { subagentType: 'explorer' });
    expect((await readState()).sessions['grok-session-1:subagent:explorer']).toMatchObject({
      status: 'running',
      startedAt: NOW
    });
  });

  it('subagent_stop finishes only the subagent session', async () => {
    await seedSessions(
      runningSession('grok', 'grok-session-1'),
      runningSession('grok', 'grok-session-1:subagent:sub-1')
    );
    await run('subagent_stop', { subagentId: 'sub-1' });
    const state = await readState();
    expect(state.sessions['grok-session-1:subagent:sub-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.sessions['grok-session-1']).toMatchObject({ status: 'running' });
    expect(state.usageBadgesAt).toBeUndefined();
  });
});

describe('hook --agent sniffing', () => {
  it('attributes a Grok-run Claude Code payload to grok', async () => {
    await runAgent({
      agent: 'claude-code',
      payload: { hookEventName: 'session_start', sessionId: 'grok-sniff-1', cwd: '/work/repo' }
    });
    const state = await readState();
    expect(Object.keys(state.sessions)).toEqual(['grok-sniff-1']);
    expect(startedView(state, 'grok-sniff-1')).toEqual(startedExpected('grok'));
  });

  it('skips a Cursor-run Claude Code payload', async () => {
    await runAgent({
      agent: 'claude-code',
      loud: true,
      payload: {
        hook_event_name: 'SessionStart',
        session_id: 'cursor-session-1',
        cwd: '/work/repo',
        cursor_version: '3.13.25'
      }
    });
    expect((await readState()).sessions).toEqual({});
    expect(stdoutWrites).toEqual(['{}\n']);
    expect(await readLog()).toContain('hook skipped: no presence source for agent=cursor event=SessionStart');
    expect(await readLog()).not.toContain('hook failed:');
  });
});

describe('registered hook event sets', () => {
  it('includes every event name presence will register', () => {
    expect(Object.keys(builtinHookDialects['claude-code'].events)).toEqual(
      expect.arrayContaining([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'StopFailure',
        'SessionEnd',
        'SubagentStart',
        'SubagentStop'
      ])
    );
    expect(Object.keys(builtinHookDialects.codex.events)).toEqual(
      expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'])
    );
    expect(Object.keys(builtinHookDialects['gemini-cli'].events)).toEqual(
      expect.arrayContaining(['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd'])
    );
    expect(Object.keys(builtinHookDialects.grok.events)).toEqual(
      expect.arrayContaining([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'StopFailure',
        'SessionEnd',
        'SubagentStart',
        'SubagentStop'
      ])
    );
  });
});
