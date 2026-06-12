import {
  markSlotSyncSuccess,
  prepareSlotSync,
  rollbackSlotSyncClaim,
  SlotRateLimitError,
  type RenderTemplates,
  type SlotSyncDecision,
  type SyncSlotResult
} from '../render.js';
import { writeLogEvent } from '../log.js';
import { valueLength } from '../log-sanitize.js';
import { loadState, saveState, withStateLock, type PresenceState } from '../state.js';

interface RenderedSlotOptions {
  force: boolean;
  now: number;
  debounceMs: number;
  ttlMs: number;
  renderTemplates?: RenderTemplates;
  usage?: { enabled: boolean; defaultWindow: number };
}

interface ExplicitSlotOptions {
  force: boolean;
  now: number;
  debounceMs: number;
  value: string;
}

export async function syncRenderedSlotWithStateLock(
  statePath: string,
  options: RenderedSlotOptions,
  updateSlot: (value: string) => Promise<void>,
  mutateState?: (state: PresenceState) => void
): Promise<SyncSlotResult> {
  let decision: SlotSyncDecision | undefined;

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    mutateState?.(state);
    decision = prepareSlotSync(state, options);
    if (decision.action === 'skip' && decision.result.status === 'skipped' && decision.result.reason === 'unchanged') {
      state.pendingSlotFlushAt = undefined;
    }
    await saveState(state, statePath);
  });

  return applySlotSyncDecision(statePath, requireDecision(decision), updateSlot);
}

export async function syncExplicitSlotValueWithStateLock(
  statePath: string,
  options: ExplicitSlotOptions,
  updateSlot: (value: string) => Promise<void>
): Promise<SyncSlotResult> {
  let decision: SlotSyncDecision | undefined;
  let result: SyncSlotResult | undefined;

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    const elapsedMs = options.now - (state.lastSlotUpdateAt ?? 0);
    if (!options.force && elapsedMs < options.debounceMs) {
      result = { status: 'skipped', reason: 'debounced', value: options.value };
      await saveState(state, statePath);
      return;
    }

    decision = {
      action: 'update',
      value: options.value,
      previousLastSlotUpdateAt: state.lastSlotUpdateAt ?? 0,
      claimedLastSlotUpdateAt: options.now
    };
    state.lastSlotUpdateAt = options.now;
    await saveState(state, statePath);
  });

  if (result) {
    return result;
  }

  return applySlotSyncDecision(statePath, requireDecision(decision), updateSlot);
}

async function applySlotSyncDecision(
  statePath: string,
  decision: SlotSyncDecision,
  updateSlot: (value: string) => Promise<void>
): Promise<SyncSlotResult> {
  if (decision.action === 'skip') {
    return decision.result;
  }

  const startedAt = Date.now();
  await writeSlotUpdateLog(decision, { result: 'start' });

  try {
    await updateSlot(decision.value);
  } catch (error) {
    if (error instanceof SlotRateLimitError) {
      await writeSlotUpdateLog(decision, {
        result: 'rate-limited',
        durationMs: Date.now() - startedAt,
        retryAfterMs: error.retryAfterMs
      });
      return { status: 'skipped', reason: 'rate-limited', value: decision.value, retryAfterMs: error.retryAfterMs };
    }
    await rollbackSlotDecision(statePath, decision);
    await writeSlotUpdateLog(decision, {
      result: 'failed',
      durationMs: Date.now() - startedAt
    });
    throw error;
  }

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    markSlotSyncSuccess(state, decision);
    state.pendingSlotFlushAt = undefined;
    await saveState(state, statePath);
  });

  await writeSlotUpdateLog(decision, {
    result: 'updated',
    durationMs: Date.now() - startedAt
  });

  return { status: 'updated', value: decision.value };
}

async function rollbackSlotDecision(statePath: string, decision: SlotSyncDecision): Promise<void> {
  if (decision.action !== 'update') {
    return;
  }
  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    rollbackSlotSyncClaim(state, decision);
    await saveState(state, statePath);
  });
}

function requireDecision(decision: SlotSyncDecision | undefined): SlotSyncDecision {
  if (!decision) {
    throw new Error('internal error: missing slot sync decision');
  }
  return decision;
}

async function writeSlotUpdateLog(
  decision: SlotSyncDecision,
  event: { result: 'start' | 'updated' | 'rate-limited' | 'failed'; durationMs?: number; retryAfterMs?: number }
): Promise<void> {
  if (decision.action !== 'update') {
    return;
  }

  try {
    await writeLogEvent({
      type: 'slot.update',
      result: event.result,
      valueLength: valueLength(decision.value),
      previousLastSlotUpdateAt: decision.previousLastSlotUpdateAt,
      claimedLastSlotUpdateAt: decision.claimedLastSlotUpdateAt,
      durationMs: event.durationMs,
      retryAfterMs: event.retryAfterMs
    });
  } catch {
    // Slot update logging is diagnostic only and must not affect hook execution.
  }
}
