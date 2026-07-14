import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({
    unref: vi.fn()
  }))
);

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}));

describe('deferred rendered update', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-deferred-update-'));
    process.env.AGENT_PRESENCE_LOG_FILE = join(tempDir, 'agent-presence.log');
    spawnMock.mockClear();
  });

  afterEach(async () => {
    delete process.env.AGENT_PRESENCE_LOG_FILE;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('spawns a cached-state flush instead of an explicit usage-refreshing update', async () => {
    const { scheduleDeferredRenderedUpdate } = await import('../src/cli/deferred-update.js');

    await scheduleDeferredRenderedUpdate({
      statePath: join(tempDir, 'state.json'),
      delayMs: 1_000,
      now: 10_000
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const wrapperArgs = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(wrapperArgs).toBeDefined();
    const wrapperScript = wrapperArgs?.[1] ?? '';
    expect(wrapperScript).toContain("[cliPath, 'flush', '--force', '--silent']");
    expect(wrapperScript).not.toContain("[cliPath, 'update'");
  });
});
