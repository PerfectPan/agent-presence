import {
  markSlotSyncSuccess,
  prepareSlotSync,
  rollbackSlotSyncClaim,
  SlotRateLimitError,
  type RenderTemplates,
  type SlotSyncDecision,
  type SyncSlotResult
} from '../render.js';
import { loadState, saveState, withStateLock, type PresenceState } from '../state.js';

interface RenderedSlotOptions {
  force: boolean;
  now: number;
  debounceMs: number;
  ttlMs: number;
  renderTemplates?: RenderTemplates;
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

  try {
    await updateSlot(decision.value);
  } catch (error) {
    if (error instanceof SlotRateLimitError) {
      return { status: 'skipped', reason: 'rate-limited', value: decision.value };
    }
    await rollbackSlotDecision(statePath, decision);
    throw error;
  }

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    markSlotSyncSuccess(state, decision);
    await saveState(state, statePath);
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
