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

describe('reset command', () => {
  let homeDir: string;
  const now = new Date(2026, 6, 14, 21, 28, 10).getTime();

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-reset-command-'));
    process.env.AGENT_PRESENCE_HOME = homeDir;
    publishValueMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await writeFile(
      join(homeDir, 'config.json'),
      JSON.stringify({
        provider: 'feishu-signature',
        debounceMs: 0,
        render: {
          zero: 'AI 牛马正在摸鱼中 | 今日 {usage_1d}'
        },
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
            source: 'codex',
            kind: 'coding',
            status: 'running',
            startedAt: now - 10_000,
            lastHeartbeatAt: now - 1_000
          }
        },
        lastSlotUpdateAt: 0,
        lastValue: '',
        usageBadges: { '1': '472M · $129.20' },
        usageBadgesAt: now - 60_000
      })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.AGENT_PRESENCE_HOME;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('keeps cached usage visible while clearing active sessions for a power event', async () => {
    const { reset } = await import('../src/cli/commands/reset.js');

    await reset(['--force', '--silent']);

    expect(publishValueMock).toHaveBeenCalledWith('AI 牛马正在摸鱼中 | 今日 472M · $129.20');
    const state = JSON.parse(await readFile(join(homeDir, 'state.json'), 'utf8'));
    expect(state.sessions.running.status).toBe('finished');
    expect(state.usageBadges).toEqual({ '1': '472M · $129.20' });
  });
});
