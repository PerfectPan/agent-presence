import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { runCli } from '../src/cli/app.js';

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
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ap-load-failure-'));
    logFile = join(workDir, 'agent-presence.log');
    previousLogFile = process.env.AGENT_PRESENCE_LOG_FILE;
    process.env.AGENT_PRESENCE_LOG_FILE = logFile;
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

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousLogFile === undefined) {
      delete process.env.AGENT_PRESENCE_LOG_FILE;
    } else {
      process.env.AGENT_PRESENCE_LOG_FILE = previousLogFile;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('ends a Codex hook like an in-hook failure: {} on stdout, no stderr, exit code 0', async () => {
    await runCli(['hook', '--source', 'codex', '--event', 'Heartbeat']);

    expect(stdoutWrites).toEqual(['{}\n']);
    expect(stderrWrites).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(logFile, 'utf8')).toContain('hook failed: hook module failed to load');
  });

  it('ends a silent Codex hook with no output, no stderr, exit code 0', async () => {
    await runCli(['hook', '--source', 'codex', '--event', 'Heartbeat', '--silent']);

    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(readFileSync(logFile, 'utf8')).toContain('hook failed: hook module failed to load');
  });
});
