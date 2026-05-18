import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getStatePath } from './config.js';
import { hasNodeErrorCode, readJsonFile, writeJsonAtomic } from './json-file.js';

export type AgentStatus = 'running' | 'finished' | 'expired';

export interface AgentSession {
  id: string;
  source: string;
  kind: 'coding';
  status: AgentStatus;
  startedAt: number;
  lastHeartbeatAt: number;
  finishedAt?: number;
  project?: string;
}

export interface PresenceState {
  sessions: Record<string, AgentSession>;
  lastSlotUpdateAt?: number;
  lastValue?: string;
  pendingSlotFlushAt?: number;
}

export interface AgentEventInput {
  source: string;
  event: string;
  sessionId: string;
  now: number;
  project?: string;
}

type NormalizedEvent = 'start' | 'heartbeat' | 'finish';

export function createEmptyState(): PresenceState {
  return {
    sessions: {},
    lastSlotUpdateAt: 0,
    lastValue: ''
  };
}

export async function loadState(statePath = getStatePath()): Promise<PresenceState> {
  return normalizeState(await readJsonFile<PresenceState>(statePath, createEmptyState()));
}

export async function saveState(state: PresenceState, statePath = getStatePath()): Promise<void> {
  await writeJsonAtomic(statePath, state);
}

export function normalizeState(raw: PresenceState): PresenceState {
  const state = raw && typeof raw === 'object' ? raw : createEmptyState();
  const sessions: Record<string, AgentSession> = {};

  for (const [id, rawSession] of Object.entries(state.sessions ?? {})) {
    const legacy = rawSession as AgentSession & { kind?: string; source?: string };
    const source = legacy.source ?? (legacy.kind && legacy.kind !== 'coding' ? legacy.kind : undefined);
    if (!legacy.id || !source || !legacy.status || !legacy.startedAt || !legacy.lastHeartbeatAt) {
      continue;
    }
    sessions[id] = {
      id: legacy.id,
      source,
      kind: 'coding',
      status: legacy.status,
      startedAt: legacy.startedAt,
      lastHeartbeatAt: legacy.lastHeartbeatAt,
      finishedAt: legacy.status === 'running' ? undefined : legacy.finishedAt,
      project: legacy.project
    };
  }

  return {
    sessions,
    lastSlotUpdateAt: state.lastSlotUpdateAt ?? 0,
    lastValue: state.lastValue ?? '',
    pendingSlotFlushAt: typeof state.pendingSlotFlushAt === 'number' ? state.pendingSlotFlushAt : undefined
  };
}

export function applyAgentEvent(state: PresenceState, input: AgentEventInput): PresenceState {
  const event = normalizeEvent(input.event);
  const existing = state.sessions[input.sessionId];

  if (event === 'finish') {
    if (existing) {
      existing.status = 'finished';
      existing.lastHeartbeatAt = input.now;
      existing.finishedAt = input.now;
      if (input.project) {
        existing.project = input.project;
      }
      return state;
    }

    const fallback = findFallbackSessionForFinish(state, input);
    if (fallback) {
      fallback.status = 'finished';
      fallback.lastHeartbeatAt = input.now;
      fallback.finishedAt = input.now;
      if (input.project) {
        fallback.project = input.project;
      }
    }

    return state;
  }

  if (event === 'heartbeat' && existing?.status === 'finished' && !isReopenHeartbeat(input.event)) {
    if (input.project && !existing.project) {
      existing.project = input.project;
    }
    return state;
  }

  state.sessions[input.sessionId] = {
    id: input.sessionId,
    source: input.source,
    kind: 'coding',
    status: 'running',
    startedAt: event === 'start' || !existing || existing.status !== 'running' ? input.now : existing.startedAt,
    lastHeartbeatAt: input.now,
    finishedAt: undefined,
    project: input.project ?? existing?.project
  };

  return state;
}

function isReopenHeartbeat(event: string): boolean {
  return event === 'UserPromptSubmit';
}

function findFallbackSessionForFinish(state: PresenceState, input: AgentEventInput): AgentSession | undefined {
  const runningSessions = Object.values(state.sessions).filter((session) => {
    if (session.status !== 'running' || session.source !== input.source) {
      return false;
    }
    return input.project ? session.project === input.project : true;
  });

  return runningSessions.sort((left, right) => right.lastHeartbeatAt - left.lastHeartbeatAt)[0];
}

export function expireStaleSessions(state: PresenceState, now: number, ttlMs: number): PresenceState {
  for (const session of Object.values(state.sessions)) {
    if (session.status === 'running' && now - session.lastHeartbeatAt > ttlMs) {
      session.status = 'expired';
    }
  }
  return state;
}

export function getActiveSessions(state: PresenceState, now: number, ttlMs: number): AgentSession[] {
  expireStaleSessions(state, now, ttlMs);
  return Object.values(state.sessions).filter(
    (session) => session.status === 'running' && now - session.lastHeartbeatAt <= ttlMs
  );
}

export function finishAllSessions(state: PresenceState, now: number): PresenceState {
  for (const session of Object.values(state.sessions)) {
    if (session.status === 'running') {
      session.status = 'finished';
      session.lastHeartbeatAt = now;
      session.finishedAt = now;
    }
  }
  return state;
}

export async function withStateLock<T>(
  statePath: string,
  fn: () => Promise<T>,
  options: { waitMs?: number; staleMs?: number } = {}
): Promise<T> {
  const lockPath = `${statePath}.lock`;
  const waitMs = options.waitMs ?? 2_000;
  const staleMs = options.staleMs ?? 10_000;
  const startedAt = Date.now();

  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await isStaleLock(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > waitMs) {
        throw new Error(`timed out waiting for state lock: ${lockPath}`);
      }
      await delay(50);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function normalizeEvent(event: string): NormalizedEvent {
  if (event === 'SessionStart' || event === 'SubagentStart' || event === 'session.created' || event === 'start') {
    return 'start';
  }
  if (
    event === 'Stop' ||
    event === 'SessionEnd' ||
    event === 'StopFailure' ||
    event === 'SubagentStop' ||
    event === 'session.deleted' ||
    event === 'session.error' ||
    event === 'session.idle' ||
    event === 'finish'
  ) {
    return 'finish';
  }
  if (
    event === 'Heartbeat' ||
    event === 'UserPromptSubmit' ||
    event === 'PreToolUse' ||
    event === 'PostToolUse' ||
    event === 'command.executed' ||
    event === 'file.edited' ||
    event === 'message.updated' ||
    event === 'session.status' ||
    event === 'session.updated' ||
    event === 'todo.updated' ||
    event === 'tool.execute.after' ||
    event === 'tool.execute.before' ||
    event === 'heartbeat'
  ) {
    return 'heartbeat';
  }
  return 'heartbeat';
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return hasNodeErrorCode(error, 'EEXIST');
}
