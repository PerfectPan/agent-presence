// Presence state types and the pure session rules. Loading, saving and the state lock live in
// `src/state-store.ts`, whose schemas load zod; keep this module free of schemas and I/O so the hook path can use it.

// Type-only, so erased: an inline `type` specifier would keep the module edge.
import type { QueueOwed } from './queue/schema.js';

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
  /** Cached usage badges for the signature, keyed by window day count. */
  usageBadges?: Record<string, string>;
  usageBadgesAt?: number;
  /** Per-window source contributions used to rebuild aggregate usage badges. */
  usageSnapshots?: Record<string, Record<string, UsageSnapshot>>;
  /** Ids of applied queue records whose files may still exist (Plan 0003 3.5). */
  queueApplied?: string[];
  /** Follow-up work that applied queue records owe, with what this release does not know kept (Plan 0003 3.5). */
  queueOwed?: QueueOwed;
}

export interface UsageSnapshot {
  totalTokens: number;
  costUsd: number | null;
  scannedAt: number;
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

function normalizeEvent(event: string): NormalizedEvent {
  if (event === 'SessionStart' || event === 'SubagentStart' || event === 'start') {
    return 'start';
  }
  if (
    event === 'Stop' ||
    event === 'SessionEnd' ||
    event === 'StopFailure' ||
    event === 'SubagentStop' ||
    event === 'finish'
  ) {
    return 'finish';
  }
  if (
    event === 'Heartbeat' ||
    event === 'UserPromptSubmit' ||
    event === 'PreToolUse' ||
    event === 'PostToolUse' ||
    event === 'heartbeat'
  ) {
    return 'heartbeat';
  }
  return 'heartbeat';
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

/**
 * Whether an event marks a session boundary (start or finish) worth refreshing
 * the usage badge on. Subagent boundaries are excluded so a session spawning
 * many subagents does not trigger a rescan per subagent.
 */
export function isSessionBoundaryEvent(event: string): boolean {
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    return false;
  }
  const normalized = normalizeEvent(event);
  return normalized === 'start' || normalized === 'finish';
}
