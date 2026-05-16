import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogWriter, formatLogEvent, formatLogTime, writeLog } from '../src/log.js';

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
