import type { RenderTemplates, SyncSlotResult } from '../render.js';
import type { PresenceState } from '../state.js';
import { scheduleDeferredRenderedUpdateForResult } from './deferred-update.js';
import { syncRenderedSlotWithStateLock } from './slot-sync.js';

interface RenderedSlotSyncOptions {
  force: boolean;
  now: number;
  debounceMs: number;
  ttlMs: number;
  renderTemplates?: RenderTemplates;
  usageEnabled?: boolean;
}

export async function syncRenderedSlotWithDeferredFlush(
  statePath: string,
  options: RenderedSlotSyncOptions,
  updateSlot: (value: string) => Promise<void>,
  mutateState?: (state: PresenceState) => void
): Promise<SyncSlotResult> {
  const result = await syncRenderedSlotWithStateLock(statePath, options, updateSlot, mutateState);
  await scheduleDeferredRenderedUpdateForResult(result, {
    statePath,
    now: options.now,
    delayMs: options.debounceMs
  });
  return result;
}
