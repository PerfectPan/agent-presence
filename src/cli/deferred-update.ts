import { spawn } from 'node:child_process';
import { loadState, saveState, withStateLock } from '../state.js';
import { writeLogEvent } from '../log.js';

const MIN_DELAY_MS = 1_000;
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;

export async function scheduleDeferredRenderedUpdate(options: {
  statePath: string;
  delayMs: number;
  now: number;
}): Promise<void> {
  const delayMs = Math.max(options.delayMs, MIN_DELAY_MS);
  const runAt = options.now + delayMs;
  let shouldSpawn = false;

  await withStateLock(options.statePath, async () => {
    const state = await loadState(options.statePath);
    const pending = state.pendingSlotFlushAt ?? 0;
    if (pending > options.now && pending <= runAt) {
      return;
    }

    state.pendingSlotFlushAt = runAt;
    await saveState(state, options.statePath);
    shouldSpawn = true;
  });

  if (!shouldSpawn) {
    return;
  }

  spawnDeferredUpdate(delayMs);
  await writeLogEvent({
    type: 'slot.update.deferred',
    result: 'scheduled',
    delayMs,
    runAt
  });
}

export async function scheduleDeferredRenderedUpdateForResult(
  result: { status: string; reason?: string; retryAfterMs?: number },
  options: {
    statePath: string;
    delayMs: number;
    now: number;
  }
): Promise<void> {
  if (result.status !== 'skipped' || (result.reason !== 'debounced' && result.reason !== 'rate-limited')) {
    return;
  }

  await scheduleDeferredRenderedUpdate({
    ...options,
    delayMs:
      result.reason === 'rate-limited'
        ? result.retryAfterMs ?? Math.max(options.delayMs, DEFAULT_RATE_LIMIT_RETRY_MS)
        : options.delayMs
  });
}

function spawnDeferredUpdate(delayMs: number): void {
  const cliPath = process.argv[1];
  if (!cliPath) {
    return;
  }

  const script = `
const { spawn } = require('node:child_process');
const delayMs = Number(process.argv[1]);
const nodePath = process.argv[2];
const cliPath = process.argv[3];
setTimeout(() => {
  const child = spawn(nodePath, [cliPath, 'flush', '--force', '--silent'], {
    detached: true,
    env: process.env,
    stdio: 'ignore'
  });
  child.unref();
}, delayMs);
`;

  const child = spawn(process.execPath, ['-e', script, String(delayMs), process.execPath, cliPath], {
    detached: true,
    env: process.env,
    stdio: 'ignore'
  });
  child.unref();
}
