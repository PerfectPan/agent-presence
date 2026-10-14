import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { runCli } from '../src/cli/app.js';
import { getStatePath } from '../src/config.js';
import { queuePaths } from '../src/queue/files.js';
import { listQueue, readQueueFile } from '../src/queue/reader.js';
import { drainQueue } from './hook-producer-support.js';

// The throwing namespace getter makes `const { hook } = await
// import('./commands/hook.js')` inside runCli reject, which is the injected
// loader failure these tests exercise. A throwing vi.mock factory would also
// reject, but vitest replaces its message with a mocking hint.
vi.mock('../src/cli/commands/hook.js', () => {
  return {
    get hook() {
      throw new Error('hook module failed to load');
    }
  };
});

describe('hook command load failure', () => {
  let workDir: string;
  let logFile: string;
  let previousLogFile: string | undefined;
  let previousHome: string | undefined;
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ap-load-failure-'));
    logFile = join(workDir, 'agent-presence.log');
    previousLogFile = process.env.AGENT_PRESENCE_LOG_FILE;
    process.env.AGENT_PRESENCE_LOG_FILE = logFile;
    // The fallback records an error record next to the state file: keep it out of the real home.
    previousHome = process.env.AGENT_PRESENCE_HOME;
    process.env.AGENT_PRESENCE_HOME = workDir;
    stdoutWrites = [];
    stderrWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Uint8Array | string) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Uint8Array | string) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousLogFile === undefined) {
      delete process.env.AGENT_PRESENCE_LOG_FILE;
    } else {
      process.env.AGENT_PRESENCE_LOG_FILE = previousLogFile;
    }
    if (previousHome === undefined) {
      delete process.env.AGENT_PRESENCE_HOME;
    } else {
      process.env.AGENT_PRESENCE_HOME = previousHome;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  /** The one error record the fallback wrote, read back through the queue reader. */
  async function recordedLoadFailureMessage(): Promise<string | undefined> {
    const { records } = await listQueue(getStatePath());
    expect(records).toHaveLength(1);
    const read = await readQueueFile(records[0]!);
    expect(read.status).toBe('record');
    if (read.status !== 'record' || read.record.kind !== 'error') {
      return undefined;
    }
    expect(read.record.code).toBe('hook-failed');
    return read.record.message;
  }

  it('ends a Codex hook like an in-hook failure: {} on stdout, no stderr, exit code 0', async () => {
    await runCli(['hook', '--source', 'codex', '--event', 'Heartbeat']);

    expect(stdoutWrites).toEqual(['{}\n']);
    expect(stderrWrites).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(await recordedLoadFailureMessage()).toBe('hook failed: hook module failed to load');
  });

  it('logs the same `hook failed` line through the worker that the hook logged before the queue', async () => {
    await runCli(['hook', '--source', 'codex', '--event', 'Heartbeat', '--silent']);

    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(await recordedLoadFailureMessage()).toBe('hook failed: hook module failed to load');

    await drainQueue();
    // The worker logs the same text; the log quotes a message with spaces.
    expect(readFileSync(logFile, 'utf8')).toContain('message="hook failed: hook module failed to load"');
    // Applied: the queue is empty again.
    expect(readdirSync(queuePaths(getStatePath()).queueDir)).toEqual([]);
  });
});
