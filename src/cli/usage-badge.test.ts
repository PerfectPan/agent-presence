import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshUsageBadgeCache } from './usage-badge.js';
import type { PresenceState } from '../state.js';
import { saveState } from '../state-store.js';
import type { HandlerBillableSource } from '../usage/index.js';

const NOW = new Date('2026-07-14T13:00:00+08:00').getTime();

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('refreshUsageBadgeCache', () => {
  it('does not start when its signal has already aborted', async () => {
    const dir = '/fake-home';
    const codexScan = vi.fn<HandlerBillableSource['scanUsage']>(async () => []);

    await expect(
      refreshUsageBadgeCache({
        statePath: join(dir, 'state.json'),
        now: NOW,
        windows: [1],
        sources: [{ id: 'codex', scanUsage: codexScan }],
        signal: AbortSignal.abort()
      })
    ).resolves.toEqual({ completed: false });
    expect(codexScan).not.toHaveBeenCalled();
  });

  it('completes without scanning or saving for a source without a scanner later in the day', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    await saveState({ sessions: {}, usageBadgesAt: NOW - 1_000 }, statePath);
    const codexScan = vi.fn<HandlerBillableSource['scanUsage']>(async () => []);
    const onSave = vi.fn<(state: PresenceState) => void>();

    const outcome = await refreshUsageBadgeCache({
      statePath,
      now: NOW,
      windows: [1],
      sources: [{ id: 'codex', scanUsage: codexScan }],
      source: 'grok',
      onSave
    });

    expect(outcome).toEqual({ completed: true });
    expect(codexScan).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
