import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const publishValueMock = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/registry.js', () => ({
  createProvider: () => ({
    id: 'feishu-signature',
    publishValue: publishValueMock
  })
}));

vi.mock('../src/secret.js', () => ({
  readCredential: vi.fn().mockResolvedValue({ token: 'test-token', slotId: 'test-slot' })
}));

describe('flush command', () => {
  let homeDir: string;
  const now = new Date(2026, 6, 14, 21, 20).getTime();

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-flush-command-'));
    process.env.AGENT_PRESENCE_HOME = homeDir;
    publishValueMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await writeFile(
      join(homeDir, 'config.json'),
      JSON.stringify({
        provider: 'feishu-signature',
        debounceMs: 60_000,
        usage: {
          showInSignature: true,
          signatureWindowDays: 1
        }
      })
    );
    await writeFile(
      join(homeDir, 'state.json'),
      JSON.stringify({
        sessions: {
          running: {
            id: 'running',
            source: 'opencode',
            kind: 'coding',
            status: 'running',
            startedAt: now - 10_000,
            lastHeartbeatAt: now - 1_000
          }
        },
        lastSlotUpdateAt: now - 1_000,
        lastValue: 'AI 牛马暂未开工 | 今日 470M · $128.00',
        pendingSlotFlushAt: now,
        usageBadges: { '1': '472M · $129.20' },
        usageBadgesAt: now - 60_000,
        usageSnapshots: {
          '1': {
            opencode: {
              totalTokens: 1_647_973,
              costUsd: 1.24451,
              scannedAt: now - 60_000
            }
          }
        }
      })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.AGENT_PRESENCE_HOME;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('publishes cached presence without rescanning usage snapshots', async () => {
    const { flush } = await import('../src/cli/commands/flush.js');

    await flush(['--force', '--silent']);

    expect(publishValueMock).toHaveBeenCalledWith('1 个 AI 牛马正在搬砖 | opencode 1 | 今日 472M · $129.20');
    const state = JSON.parse(await readFile(join(homeDir, 'state.json'), 'utf8'));
    expect(state.usageSnapshots['1'].opencode).toEqual({
      totalTokens: 1_647_973,
      costUsd: 1.24451,
      scannedAt: now - 60_000
    });
  });
});
