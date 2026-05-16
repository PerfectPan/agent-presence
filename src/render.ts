import type { AgentSession, PresenceState } from './state.js';
import { expireStaleSessions, getActiveSessions } from './state.js';

export interface RenderTemplates {
  zero?: string;
  one?: string;
  many?: string;
}

export const DEFAULT_RENDER_TEMPLATES: Required<RenderTemplates> = {
  zero: 'AI 牛马暂未开工',
  one: '{total} 个 AI 牛马正在搬砖 | {details}',
  many: '{total} 个 AI 牛马正在搬砖 | {details}'
};

export interface SyncSlotOptions {
  force: boolean;
  now: number;
  debounceMs: number;
  ttlMs: number;
  renderTemplates?: RenderTemplates;
  updateSlot: (value: string) => Promise<void>;
}

export type SyncSlotResult =
  | { status: 'updated'; value: string }
  | { status: 'skipped'; reason: 'unchanged' | 'debounced' | 'rate-limited'; value: string; retryAfterMs?: number };

export interface SlotSyncDecisionOptions {
  force: boolean;
  now: number;
  debounceMs: number;
  ttlMs: number;
  renderTemplates?: RenderTemplates;
}

export type SlotSyncDecision =
  | { action: 'skip'; result: SyncSlotResult }
  | {
      action: 'update';
      value: string;
      previousLastSlotUpdateAt: number;
      claimedLastSlotUpdateAt: number;
    };

export class SlotRateLimitError extends Error {
  readonly retryAfterMs?: number;

  constructor(message = 'slot provider rate limited the update', retryAfterMs?: number) {
    super(message);
    this.name = 'SlotRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function renderPresence(activeSessions: AgentSession[], templates: RenderTemplates = {}): string {
  const resolvedTemplates = resolveRenderTemplates(templates);
  const details = renderDetails(activeSessions);
  const total = activeSessions.length;

  if (activeSessions.length === 0) {
    return formatTemplate(resolvedTemplates.zero, { total, details }).slice(0, 200);
  }

  const template = total === 1 ? resolvedTemplates.one : resolvedTemplates.many;
  return formatTemplate(template, { total, details }).slice(0, 200);
}

function renderDetails(activeSessions: AgentSession[]): string {
  const counts = new Map<string, number>();
  for (const session of activeSessions) {
    counts.set(session.source, (counts.get(session.source) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([source, count]) => `${source} ${count}`)
    .join(' · ');
}

function formatTemplate(template: string, variables: { total: number; details: string }): string {
  return template.replaceAll('{total}', String(variables.total)).replaceAll('{details}', variables.details);
}

function resolveRenderTemplates(templates: RenderTemplates): Required<RenderTemplates> {
  return {
    zero: templates.zero ?? DEFAULT_RENDER_TEMPLATES.zero,
    one: templates.one ?? DEFAULT_RENDER_TEMPLATES.one,
    many: templates.many ?? DEFAULT_RENDER_TEMPLATES.many
  };
}

export async function syncSlot(state: PresenceState, options: SyncSlotOptions): Promise<SyncSlotResult> {
  const decision = prepareSlotSync(state, options);
  if (decision.action === 'skip') {
    return decision.result;
  }

  try {
    await options.updateSlot(decision.value);
  } catch (error) {
    if (error instanceof SlotRateLimitError) {
      return { status: 'skipped', reason: 'rate-limited', value: decision.value, retryAfterMs: error.retryAfterMs };
    }
    rollbackSlotSyncClaim(state, decision);
    throw error;
  }

  markSlotSyncSuccess(state, decision);
  return { status: 'updated', value: decision.value };
}

export function prepareSlotSync(state: PresenceState, options: SlotSyncDecisionOptions): SlotSyncDecision {
  expireStaleSessions(state, options.now, options.ttlMs);
  const value = renderPresence(getActiveSessions(state, options.now, options.ttlMs), options.renderTemplates);
  const elapsedMs = options.now - (state.lastSlotUpdateAt ?? 0);

  if (!options.force && state.lastValue === value) {
    return { action: 'skip', result: { status: 'skipped', reason: 'unchanged', value } };
  }

  if (!options.force && elapsedMs < options.debounceMs) {
    return { action: 'skip', result: { status: 'skipped', reason: 'debounced', value } };
  }

  const previousLastSlotUpdateAt = state.lastSlotUpdateAt ?? 0;
  state.lastSlotUpdateAt = options.now;
  return {
    action: 'update',
    value,
    previousLastSlotUpdateAt,
    claimedLastSlotUpdateAt: options.now
  };
}

export function markSlotSyncSuccess(state: PresenceState, decision: SlotSyncDecision): void {
  if (decision.action !== 'update') {
    return;
  }
  if ((state.lastSlotUpdateAt ?? 0) === decision.claimedLastSlotUpdateAt) {
    state.lastValue = decision.value;
  }
}

export function rollbackSlotSyncClaim(state: PresenceState, decision: SlotSyncDecision): void {
  if (decision.action !== 'update') {
    return;
  }
  if ((state.lastSlotUpdateAt ?? 0) === decision.claimedLastSlotUpdateAt) {
    state.lastSlotUpdateAt = decision.previousLastSlotUpdateAt;
  }
}
