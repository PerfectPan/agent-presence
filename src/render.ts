import type { AgentSession, PresenceState } from './state.js';
import { expireStaleSessions, getActiveSessions } from './state.js';
import { calendarDaysBetween } from './time.js';

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
  /** Usage badges to expose as `{usage}` / `{usage_Nd}` template variables. */
  usage?: { enabled: boolean; defaultWindow: number };
}

/** Matches `{usage}` and `{usage_<N>d}` template tokens. */
const USAGE_TOKEN = /\{usage(?:_(\d+)d)?\}/g;

/** Shown in place of a usage badge that is too old to trust (see below). */
export const STALE_USAGE_PLACEHOLDER = '—';

/**
 * Whether a window's cached badge, computed at `computedAt`, is too stale to
 * display at `now`. Windows are calendar-day aligned, so a badge becomes stale
 * once enough midnights have passed that its whole span has rolled over: the
 * 1-day `今日` badge is stale after a single midnight (it now reports the wrong
 * day), while the 7-day badge survives until seven days have elapsed. An unknown
 * compute time (legacy cache) is treated as fresh.
 */
function isUsageStale(days: number, computedAt: number | undefined, now: number): boolean {
  if (computedAt === undefined) {
    return false;
  }
  return calendarDaysBetween(computedAt, now) >= days;
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

/**
 * Render the signature value. `usageVars` maps template variable names (without
 * braces, e.g. `usage`, `usage_1d`, `usage_7d`) to their badge text; consumers
 * compose their own label by placing those tokens in a render template. When a
 * template references no `{usage*}` token but `autoAppend` is provided, it is
 * appended — the zero-config path for "just turn it on".
 */
export function renderPresence(
  activeSessions: AgentSession[],
  templates: RenderTemplates = {},
  usageVars: Record<string, string> = {},
  autoAppend = ''
): string {
  const resolvedTemplates = resolveRenderTemplates(templates);
  const details = renderDetails(activeSessions);
  const total = activeSessions.length;

  const template = total === 0 ? resolvedTemplates.zero : total === 1 ? resolvedTemplates.one : resolvedTemplates.many;
  const hasUsageToken = USAGE_TOKEN.test(template);
  USAGE_TOKEN.lastIndex = 0;

  let rendered = formatTemplate(template, { total, details, usageVars });
  if (!hasUsageToken && autoAppend.length > 0) {
    rendered = `${rendered}${autoAppend}`;
  }
  return rendered.slice(0, 200);
}

/** Human label for a usage window: 1→"今日", 7→"近7天", N→"近N天". */
export function usageWindowLabel(days: number): string {
  return days === 1 ? '今日' : `近${days}天`;
}

/**
 * Rolling-window day counts referenced by these templates: any `{usage_Nd}`
 * token, plus `defaultDays` whenever a bare `{usage}` token appears.
 */
export function referencedUsageWindows(templates: RenderTemplates, defaultDays: number): number[] {
  const resolved = resolveRenderTemplates(templates);
  const windows = new Set<number>();
  for (const template of [resolved.zero, resolved.one, resolved.many]) {
    for (const match of template.matchAll(USAGE_TOKEN)) {
      windows.add(match[1] ? Number.parseInt(match[1], 10) : defaultDays);
    }
  }
  return [...windows];
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

function formatTemplate(
  template: string,
  variables: { total: number; details: string; usageVars: Record<string, string> }
): string {
  const base = template.replaceAll('{total}', String(variables.total)).replaceAll('{details}', variables.details);
  // Substitute every `{usage}` / `{usage_Nd}` token from the provided vars; any
  // referenced-but-unavailable window collapses to empty rather than leaking the token.
  return base.replace(USAGE_TOKEN, (_match, days?: string) => {
    const key = days ? `usage_${days}d` : 'usage';
    return variables.usageVars[key] ?? '';
  });
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
  const { usageVars, autoAppend } = resolveUsageForRender(state, options.usage, options.now);
  const value = renderPresence(
    getActiveSessions(state, options.now, options.ttlMs),
    options.renderTemplates,
    usageVars,
    autoAppend
  );
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

/**
 * Build the `{usage*}` substitution map (and the zero-config auto-append) from
 * the badges cached in state. Each cached window `N` becomes `usage_Nd`, and the
 * default window is also exposed as bare `usage`.
 */
export function resolveUsageForRender(
  state: PresenceState,
  usage: SlotSyncDecisionOptions['usage'],
  now: number
): { usageVars: Record<string, string>; autoAppend: string } {
  if (!usage?.enabled) {
    return { usageVars: {}, autoAppend: '' };
  }
  const badges = state.usageBadges ?? {};
  const computedAt = state.usageBadgesAt;
  const usageVars: Record<string, string> = {};
  for (const [days, badge] of Object.entries(badges)) {
    usageVars[`usage_${days}d`] = isUsageStale(Number(days), computedAt, now) ? STALE_USAGE_PLACEHOLDER : badge;
  }

  const defaultDays = usage.defaultWindow;
  const defaultStale = isUsageStale(defaultDays, computedAt, now);
  const rawDefault = badges[String(defaultDays)];
  usageVars.usage = rawDefault === undefined ? '' : defaultStale ? STALE_USAGE_PLACEHOLDER : rawDefault;

  // The zero-config auto-append owns its whole label, so a stale default window
  // is dropped rather than appended as a bare placeholder.
  const autoAppend =
    rawDefault !== undefined && !defaultStale ? ` | ${usageWindowLabel(defaultDays)} ${rawDefault}` : '';
  return { usageVars, autoAppend };
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
