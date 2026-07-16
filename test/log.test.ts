import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogWriter, formatLogEvent, formatLogTime, writeLog } from '../src/log.js';
import { LOG_LOCK_MARKER } from '../src/log-retention.js';

describe('log timestamps', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.AGENT_PRESENCE_LOG_FILE;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('formats timestamps in China time with an explicit offset', () => {
    expect(formatLogTime(new Date('2026-05-16T13:59:49.227Z'))).toBe('2026-05-16T21:59:49.227+08:00');
  });

  it('writes text and structured log lines with China-time timestamps', async () => {
    const logPath = await useTempLogFile();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T13:59:49.227Z'));

    await writeLog('hook failed');
    await createLogWriter({ type: 'test.event' }).event({ result: 'ok' });

    const [textLine, eventLine] = (await readFile(logPath, 'utf8')).trim().split('\n');
    expect(textLine).toBe(
      `time=2026-05-16T21:59:49.227+08:00 level=error app=agent-presence pid=${process.pid} message="hook failed"`
    );
    expect(eventLine).toBe(
      `time=2026-05-16T21:59:49.227+08:00 level=info app=agent-presence pid=${process.pid} type=test.event result=ok`
    );
  });

  it('compacts an oversized log while appending a new line', async () => {
    const logPath = await useTempLogFile();
    const oldLines = Array.from(
      { length: 6_200 },
      (_, index) => `sequence=${index} payload=${'x'.repeat(1_000)}\n`
    ).join('');
    await writeFile(logPath, oldLines, { mode: 0o600 });

    await writeLog('latest failure');

    const contents = await readFile(logPath, 'utf8');
    const file = await stat(logPath);
    expect(file.size).toBeLessThan(2 * 1024 * 1024);
    expect(contents).not.toContain('sequence=0 ');
    expect(contents).toContain('sequence=6199 ');
    expect(contents).toContain('message="latest failure"');
  });

  it('bounds a single oversized log event immediately', async () => {
    const logPath = await useTempLogFile();

    await writeLog('x'.repeat(6 * 1024 * 1024));

    const contents = await readFile(logPath, 'utf8');
    const file = await stat(logPath);
    expect(file.size).toBeLessThan(2 * 1024 * 1024);
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('preserves concurrent events while compacting an oversized log', async () => {
    const logPath = await useTempLogFile();
    const oldLines = Array.from(
      { length: 6_200 },
      (_, index) => `sequence=${index} payload=${'x'.repeat(1_000)}\n`
    ).join('');
    await writeFile(logPath, oldLines, { mode: 0o600 });

    await Promise.all(Array.from({ length: 20 }, (_, index) => writeLog(`concurrent-${index}`)));

    const contents = await readFile(logPath, 'utf8');
    for (let index = 0; index < 20; index += 1) {
      expect(contents).toContain(`message=concurrent-${index}`);
    }
    await expect(stat(`${logPath}.agent-presence.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims only stale locks created by agent-presence', async () => {
    const logPath = await useTempLogFile();
    const lockPath = `${logPath}.agent-presence.lock`;
    await writeFile(lockPath, `${LOG_LOCK_MARKER}:99999999:${randomUUID()}\n`, { mode: 0o600 });
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);

    await writeLog('after stale lock');

    expect(await readFile(logPath, 'utf8')).toContain('message="after stale lock"');
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent writers that reclaim the same stale lock', async () => {
    const logPath = await useTempLogFile();
    const lockPath = `${logPath}.agent-presence.lock`;
    await writeFile(lockPath, `${LOG_LOCK_MARKER}:99999999:${randomUUID()}\n`, { mode: 0o600 });
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);

    await Promise.all(Array.from({ length: 20 }, (_, index) => writeLog(`reclaimed-${index}`)));

    const contents = await readFile(logPath, 'utf8');
    for (let index = 0; index < 20; index += 1) {
      expect(contents).toContain(`message=reclaimed-${index}`);
    }
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never deletes an unrelated lock path', async () => {
    const logPath = await useTempLogFile();
    const lockPath = `${logPath}.agent-presence.lock`;
    await mkdir(lockPath, { mode: 0o700 });
    const userDataPath = join(lockPath, 'user-data.txt');
    await writeFile(userDataPath, 'keep me', { mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    await writeLog('blocked by foreign lock');

    expect(await readFile(userDataPath, 'utf8')).toBe('keep me');
    expect(await readFile(logPath, 'utf8')).toContain('message="blocked by foreign lock"');
  });

  it('never reclaims a lock owned by a live process', async () => {
    const logPath = await useTempLogFile();
    const lockPath = `${logPath}.agent-presence.lock`;
    const token = `${LOG_LOCK_MARKER}:${process.pid}:${randomUUID()}\n`;
    await writeFile(lockPath, token, { mode: 0o600 });
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);

    await writeLog('blocked by live owner');

    expect(await readFile(lockPath, 'utf8')).toBe(token);
    await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('formats event values as readable single-line fields', () => {
    expect(formatLogEvent({
      type: 'hook.event',
      status: 200,
      hasSessionId: true,
      project: '/tmp/project',
      payloadKeys: ['cwd', 'session_id'],
      message: 'missing slot credential'
    })).toBe(
      'type=hook.event status=200 hasSessionId=true project=/tmp/project payloadKeys=[cwd,session_id] message="missing slot credential"'
    );
  });

  async function useTempLogFile(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-log-test-'));
    const logPath = join(tempDir, 'agent-presence.log');
    process.env.AGENT_PRESENCE_LOG_FILE = logPath;
    return logPath;
  }
});
