import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite-plus';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hook } from '../src/cli/commands/hook.js';
import { buildOpenCodePluginSource, buildPiExtensionSource } from '../src/installers.js';
import { createEmptyState, loadState, saveState, type AgentSession } from '../src/state.js';

// Regression oracle for today's hook-event mapping: one case per row of the
// agent-kit adoption plan's event table (docs/plans/0002-agent-kit-adoption.md
// section 3.4) that has a today-rule. Existing-source cases run the way today's
// installed hooks run them: Claude/Codex/Gemini/Grok cases call
// `hook --source <id> --event <Name>` directly; opencode and Pi cases go
// through the generated old bridge/extension themselves, so the row asserts
// the mapping those generators actually perform, not a pre-mapped presence
// name. Every case seeds a state where start, heartbeat and finish diverge
// (a running session whose startedAt is in the past, so a start would reset
// it) and asserts the boundary effect (usage badge refresh or not) alongside
// the state change. The cases must keep passing unchanged when hook
// interpretation moves to the kit.

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
  scheduleDeferredRenderedUpdateForResult: async () => undefined
}));

const NOW = new Date(2026, 9, 9, 15, 0).getTime();
// Movable clock: cases that drive several lifecycle steps through a bridge
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
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'AGENT_PRESENCE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_HOOK_EVENT_NAME',
  'CLAUDE_SESSION_ID',
  'CLAUDE_TRANSCRIPT_PATH',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
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
  event: string;
  payload: unknown;
  env?: Record<string, string>;
  /** Installed Codex hooks run without --silent; everything else is silent. */
  loud?: boolean;
}

async function runHook(run: HookRun): Promise<void> {
  stdinPayload.current = run.payload;
  for (const [key, value] of Object.entries(run.env ?? {})) {
    process.env[key] = value;
  }
  stdoutWrites.length = 0;
  const args = ['--source', run.source, '--event', run.event];
  if (!run.loud) {
    args.push('--silent');
  }
  await hook(args);
}

// --- Generated bridge/extension harness -------------------------------------
//
// The opencode and Pi rows do not call `hook` with pre-mapped presence names.
// They evaluate the generators' output with a fake host and a capture script
// standing in for the CLI, then feed each captured invocation (the source,
// event, env and stdin the generator chose) into the in-process hook command.

const CAPTURE_SCRIPT = `import { appendFileSync, readFileSync } from "node:fs";
const captureFile = process.argv[2];
const args = process.argv.slice(3);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const ENV_KEYS = [
  "OPENCODE_CWD",
  "OPENCODE_HOOK_EVENT",
  "OPENCODE_PROJECT",
  "OPENCODE_SESSION_ID",
  "PI_CWD",
  "PI_EVENT",
  "PI_HOOK_EVENT",
  "PI_PROJECT",
  "PI_SESSION_ID",
];
const env = {};
for (const key of ENV_KEYS) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
appendFileSync(
  captureFile,
  JSON.stringify({
    source: flag("--source"),
    event: flag("--event"),
    env,
    stdin: readFileSync(0, "utf8"),
  }) + "\\n"
);
`;

interface CapturedInvocation {
  source: string;
  event: string;
  env: Record<string, string>;
  stdin: unknown;
}

interface CaptureReader {
  next: () => Promise<CapturedInvocation>;
  expectNone: () => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCaptureLines(file: string): Promise<string[]> {
  const content = await readFile(file, 'utf8').catch(() => '');
  return content.split('\n').filter((line) => line.length > 0);
}

function createCaptureReader(file: string): CaptureReader {
  let consumed = 0;
  return {
    // Fire-and-forget spawns land asynchronously; poll for the record.
    async next() {
      const start = performance.now();
      for (;;) {
        const lines = await readCaptureLines(file);
        const line = lines[consumed];
        if (line !== undefined) {
          consumed += 1;
          const record: { source: string; event: string; env: Record<string, string>; stdin: string } =
            JSON.parse(line);
          return {
            source: record.source,
            event: record.event,
            env: record.env,
            stdin: JSON.parse(record.stdin || '{}')
          };
        }
        if (performance.now() - start > 5_000) {
          throw new Error(`timed out waiting for a captured hook invocation in ${file}`);
        }
        await delay(10);
      }
    },
    async expectNone() {
      await delay(200);
      expect(await readCaptureLines(file)).toEqual([]);
    }
  };
}

async function runCaptured(captures: CaptureReader): Promise<void> {
  const invocation = await captures.next();
  await runHook({
    source: invocation.source,
    event: invocation.event,
    payload: invocation.stdin,
    env: invocation.env
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface OpenCodeBridgeHandlers {
  event: (input: { event: Record<string, unknown> }) => Promise<void>;
  'tool.execute.before': (input: Record<string, unknown>) => Promise<void>;
  'tool.execute.after': (input: Record<string, unknown>) => Promise<void>;
}

interface OpenCodeBridge {
  busEvent: (event: Record<string, unknown>) => Promise<void>;
  toolBefore: (input: Record<string, unknown>) => Promise<void>;
  toolAfter: (input: Record<string, unknown>) => Promise<void>;
  captures: CaptureReader;
}

async function loadOpenCodeBridge(): Promise<OpenCodeBridge> {
  const captureFile = join(homeDir, 'opencode-hook-captures.jsonl');
  const scriptFile = join(homeDir, 'capture-hook.mjs');
  await writeFile(scriptFile, CAPTURE_SCRIPT);
  const pluginFile = join(homeDir, 'opencode-bridge.mjs');
  await writeFile(pluginFile, buildOpenCodePluginSource(['node', scriptFile, captureFile]));
  const module: unknown = await import(pathToFileURL(pluginFile).href);
  if (!isRecord(module) || typeof module.AgentSignaturePlugin !== 'function') {
    throw new Error('the generated opencode plugin does not export AgentSignaturePlugin');
  }
  const handlers: OpenCodeBridgeHandlers = await module.AgentSignaturePlugin({ directory: '/work/repo' });
  return {
    busEvent: (event) => handlers.event({ event }),
    toolBefore: (input) => handlers['tool.execute.before'](input),
    toolAfter: (input) => handlers['tool.execute.after'](input),
    captures: createCaptureReader(captureFile)
  };
}

type PiEventHandler = (event: unknown, ctx: PiHostContext) => unknown;

interface PiHostContext {
  sessionManager: { getSessionId: () => string };
  cwd: string;
}

interface PiExtensionHost {
  handlers: Map<string, PiEventHandler>;
  context: PiHostContext;
  captures: CaptureReader;
}

async function loadPiExtension(): Promise<PiExtensionHost> {
  const captureFile = join(homeDir, 'pi-hook-captures.jsonl');
  const scriptFile = join(homeDir, 'capture-hook.mjs');
  await writeFile(scriptFile, CAPTURE_SCRIPT);
  // A broken transpile surfaces as the import below failing with a syntax
  // error; the default-export check then reports the missing extension.
  const transpiled = await transformWithOxc(
    buildPiExtensionSource(['node', scriptFile, captureFile]),
    'pi-extension.ts'
  );
  const extensionFile = join(homeDir, 'pi-extension.mjs');
  await writeFile(extensionFile, transpiled.code);
  const module: unknown = await import(pathToFileURL(extensionFile).href);
  if (!isRecord(module) || typeof module.default !== 'function') {
    throw new Error('the generated Pi extension has no default export');
  }
  const handlers = new Map<string, PiEventHandler>();
  module.default({
    on: (name: string, handler: PiEventHandler) => {
      handlers.set(name, handler);
    }
  });
  return {
    handlers,
    context: { sessionManager: { getSessionId: () => 'pi-session-1' }, cwd: '/work/repo' },
    captures: createCaptureReader(captureFile)
  };
}

async function firePiEvent(extension: PiExtensionHost, name: string): Promise<void> {
  const handler = extension.handlers.get(name);
  // An unregistered Pi event delivers nothing to the CLI.
  if (!handler) {
    return;
  }
  await handler({}, extension.context);
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
const BILLABLE_SOURCE_IDS = ['claude', 'codex', 'dsh', 'gemini', 'opencode', 'pi'];

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

describe('hook event table — Gemini CLI (today registrations)', () => {
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

  it('UserPromptSubmit reopens a finished session (old-form invocation keeps the signal)', async () => {
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

describe('hook event table — opencode (driven through the generated old bridge)', () => {
  let bridge: OpenCodeBridge;

  beforeEach(async () => {
    bridge = await loadOpenCodeBridge();
  });

  // The old bridge only emits once it has seen a created session (it remembers
  // the id it last saw); rows about later lifecycle events replay a
  // session.created first, then reseed the discriminating state and drive the
  // row's own event.
  const withLiveSession = async (drive: () => Promise<void>, seed?: AgentSession[]) => {
    await bridge.busEvent({
      type: 'session.created',
      properties: { info: { id: 'opencode-session-1', directory: '/work/repo' } }
    });
    await runCaptured(bridge.captures);
    await seedSessions(...(seed ?? [runningSession('opencode', 'opencode-session-1')]));
    await drive();
    await runCaptured(bridge.captures);
  };

  it('session.created starts the session and refreshes the usage badge', async () => {
    await bridge.busEvent({
      type: 'session.created',
      properties: { info: { id: 'opencode-session-1', directory: '/work/repo' } }
    });
    await runCaptured(bridge.captures);

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      source: 'opencode',
      status: 'running',
      startedAt: NOW,
      project: '/work/repo'
    });
    expect(state.usageBadgesAt).toBe(NOW);
    expect(Object.keys(state.usageSnapshots?.['1'] ?? {}).sort()).toEqual(BILLABLE_SOURCE_IDS);
  }, 20_000);

  it('session.created restarts a running session (startedAt resets)', async () => {
    await seedSessions(runningSession('opencode', 'opencode-session-1'));
    await bridge.busEvent({
      type: 'session.created',
      properties: { info: { id: 'opencode-session-1', directory: '/work/repo' } }
    });
    await runCaptured(bridge.captures);

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW
    });
    expect(state.usageBadgesAt).toBe(NOW);
  }, 20_000);

  it.each([
    ['busy', { status: { type: 'busy' } }],
    ['retry', { status: { type: 'retry' } }]
  ])(
    'session.status %s stays a heartbeat without a badge refresh',
    async (_name, status) => {
      await withLiveSession(() => bridge.busEvent({ type: 'session.status', properties: status }));

      const state = await readState();
      expect(state.sessions['opencode-session-1']).toMatchObject({
        status: 'running',
        startedAt: NOW - 60_000,
        lastHeartbeatAt: NOW
      });
      expect(state.usageBadgesAt).toBeUndefined();
    },
    20_000
  );

  it('session.status idle finishes the session and refreshes the usage badge', async () => {
    await withLiveSession(() => bridge.busEvent({ type: 'session.status', properties: { status: { type: 'idle' } } }));

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(state.usageBadgesAt).toBe(NOW);
  }, 20_000);

  it.each([
    ['message.updated', { info: { id: 'msg_1', sessionID: 'opencode-session-1' } }],
    ['message.part.updated', { part: { id: 'prt_1', sessionID: 'opencode-session-1' } }]
  ])(
    '%s keeps the session alive',
    async (type, properties) => {
      await withLiveSession(() => bridge.busEvent({ type, properties }));

      const state = await readState();
      expect(state.sessions['opencode-session-1']).toMatchObject({
        status: 'running',
        startedAt: NOW - 60_000,
        lastHeartbeatAt: NOW
      });
      expect(state.usageBadgesAt).toBeUndefined();
    },
    20_000
  );

  it.each(['tool.execute.before', 'tool.execute.after'])(
    '%s keeps the session alive',
    async (type) => {
      await withLiveSession(async () => {
        const toolHook = type === 'tool.execute.before' ? bridge.toolBefore : bridge.toolAfter;
        await toolHook({ tool: 'bash' });
      });

      const state = await readState();
      expect(state.sessions['opencode-session-1']).toMatchObject({
        status: 'running',
        startedAt: NOW - 60_000,
        lastHeartbeatAt: NOW
      });
      expect(state.usageBadgesAt).toBeUndefined();
    },
    20_000
  );

  it.each([
    'command.executed',
    'file.edited',
    'todo.updated',
    'session.diff',
    'session.updated',
    'permission.asked',
    'permission.replied'
  ])(
    '%s keeps the session alive',
    async (type) => {
      await withLiveSession(() => bridge.busEvent({ type }));

      const state = await readState();
      expect(state.sessions['opencode-session-1']).toMatchObject({
        status: 'running',
        startedAt: NOW - 60_000,
        lastHeartbeatAt: NOW
      });
      expect(state.usageBadgesAt).toBeUndefined();
    },
    20_000
  );

  it.each(['session.idle', 'session.error', 'session.deleted'])(
    '%s finishes the session and refreshes the usage badge',
    async (type) => {
      await withLiveSession(() => bridge.busEvent({ type }));

      const state = await readState();
      expect(state.sessions['opencode-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
      expect(state.usageBadgesAt).toBe(NOW);
    },
    20_000
  );

  it('a finished session stays finished on message updates (no reopen path)', async () => {
    await withLiveSession(
      () =>
        bridge.busEvent({
          type: 'message.updated',
          properties: { info: { id: 'msg_1', sessionID: 'opencode-session-1' } }
        }),
      [{ ...runningSession('opencode', 'opencode-session-1'), ...finishedOverrides() }]
    );

    const state = await readState();
    expect(state.sessions['opencode-session-1']).toMatchObject({
      status: 'finished',
      finishedAt: NOW - 20_000,
      lastHeartbeatAt: NOW - 30_000
    });
    expect(state.usageBadgesAt).toBeUndefined();
  }, 20_000);

  it('a late message from the previous session stays on the env session (bridge sequence)', async () => {
    // session.created A, then B: the bridge remembers the newest created
    // session in OPENCODE_SESSION_ID.
    await bridge.busEvent({ type: 'session.created', properties: { info: { id: 'ses_a', directory: '/work/repo' } } });
    await runCaptured(bridge.captures);
    await bridge.busEvent({ type: 'session.created', properties: { info: { id: 'ses_b', directory: '/work/repo' } } });
    await runCaptured(bridge.captures);

    // A late message.updated from session A carries A's id in
    // properties.info.sessionID, but the bridge does not read it there and
    // emits OPENCODE_SESSION_ID=B; the heartbeat must land on B.
    advanceMs(5_000);
    await bridge.busEvent({ type: 'message.updated', properties: { info: { id: 'msg_1', sessionID: 'ses_a' } } });
    await runCaptured(bridge.captures);

    const state = await readState();
    expect(state.sessions['ses_b']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW + 5_000
    });
    expect(state.sessions['ses_a']).toMatchObject({
      status: 'running',
      startedAt: NOW,
      lastHeartbeatAt: NOW
    });
    // The badge was refreshed by the two session.created starts and not by the
    // late heartbeat (a boundary would have moved it to NOW + 5_000).
    expect(state.usageBadgesAt).toBe(NOW);
  }, 20_000);
});

describe('hook event table — Pi (driven through the generated old extension)', () => {
  let extension: PiExtensionHost;

  beforeEach(async () => {
    extension = await loadPiExtension();
  });

  const runPi = async (name: string) => {
    await firePiEvent(extension, name);
    await runCaptured(extension.captures);
  };

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
  }, 20_000);

  it('session_start has no handler — opening Pi creates no session', async () => {
    expect(extension.handlers.has('session_start')).toBe(false);
    await firePiEvent(extension, 'session_start');
    await extension.captures.expectNone();

    const state = await readState();
    expect(state.sessions).toEqual({});
    expect(state.usageBadgesAt).toBeUndefined();
  }, 20_000);

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
    },
    20_000
  );

  it.each(['agent_end', 'session_shutdown'])(
    '%s (Stop) finishes the running session and refreshes the usage badge',
    async (name) => {
      await seedSessions(runningSession('pi', 'pi-session-1'));
      await runPi(name);

      const state = await readState();
      expect(state.sessions['pi-session-1']).toMatchObject({ status: 'finished', finishedAt: NOW });
      expect(state.usageBadgesAt).toBe(NOW);
    },
    20_000
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
  }, 20_000);
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
    expect(Object.keys(state.usageSnapshots?.['1'] ?? {})).not.toContain('grok');
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
