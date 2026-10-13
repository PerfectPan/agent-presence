import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireProcessLock, isProcessLockHeld, type ProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { kitPlatform } from '../src/kit-platform.js';
import { createLogWriter, formatLogEvent, formatLogTime, writeLog } from '../src/log.js';
import { appendRetainedLogLine } from '../src/log-retention.js';

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

  async function useTempLogFile(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-log-test-'));
    const logPath = join(tempDir, 'agent-presence.log');
    process.env.AGENT_PRESENCE_LOG_FILE = logPath;
    return logPath;
  }

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
    await expect(isProcessLockHeld(kitPlatform(), `${logPath}.lock.db`)).resolves.toBe(false);
  });

  async function holdLogLock(logPath: string): Promise<ProcessLock> {
    const held = await acquireProcessLock(kitPlatform(), `${logPath}.lock.db`);
    if (!held.ok) {
      throw new Error('the test could not take the log lock');
    }
    return held.value;
  }

  it('skips the line when the log lock stays held until the wait ends', async () => {
    const logPath = await useTempLogFile();
    const holder = await holdLogLock(logPath);
    const wait = new AbortController();

    const appended = appendRetainedLogLine(logPath, 'skipped\n', { signal: wait.signal });
    // Let the append reach the kit's wait for the held lock before the wait ends.
    await new Promise((resolve) => setImmediate(resolve));
    wait.abort();

    await expect(appended).resolves.toBe(false);
    await holder.release();
    await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes the line once the holder releases the log lock', async () => {
    const logPath = await useTempLogFile();
    const holder = await holdLogLock(logPath);

    const appended = appendRetainedLogLine(logPath, 'after release\n', { signal: new AbortController().signal });
    await holder.release();

    await expect(appended).resolves.toBe(true);
    expect(await readFile(logPath, 'utf8')).toBe('after release\n');
  });

  it('appends without the lock and leaves a foreign lock path alone when the lock cannot be taken', async () => {
    const logPath = await useTempLogFile();
    const lockPath = `${logPath}.lock.db`;
    await mkdir(lockPath, { mode: 0o700 });
    const userDataPath = join(lockPath, 'user-data.txt');
    await writeFile(userDataPath, 'keep me', { mode: 0o600 });

    await writeLog('lock unavailable');

    expect(await readFile(userDataPath, 'utf8')).toBe('keep me');
    expect(await readFile(logPath, 'utf8')).toContain('message="lock unavailable"');
  });

  it('formats event values as readable single-line fields', () => {
    expect(
      formatLogEvent({
        type: 'hook.event',
        status: 200,
        hasSessionId: true,
        project: '/tmp/project',
        payloadKeys: ['cwd', 'session_id'],
        message: 'missing slot credential'
      })
    ).toBe(
      'type=hook.event status=200 hasSessionId=true project=/tmp/project payloadKeys=[cwd,session_id] message="missing slot credential"'
    );
  });
});
