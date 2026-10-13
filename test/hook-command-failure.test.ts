import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// The module loads and its `hook` throws: an error from inside the hook
// command must reach the generic catch in src/cli.ts, not the dispatcher's
// load-failure fallback that test/hook-load-failure.test.ts covers.
vi.mock('../src/cli/commands/hook.js', () => {
  return {
    async hook() {
      throw new Error('hook command failed');
    }
  };
});

describe('hook command failure', () => {
  let workDir: string;
  let logFile: string;
  let previousLogFile: string | undefined;
  let previousArgv: string[];
  let previousExitCode: typeof process.exitCode;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let consoleErrors: unknown[][];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ap-hook-failure-'));
    logFile = join(workDir, 'agent-presence.log');
    previousLogFile = process.env.AGENT_PRESENCE_LOG_FILE;
    process.env.AGENT_PRESENCE_LOG_FILE = logFile;
    previousArgv = process.argv;
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    stdoutWrites = [];
    stderrWrites = [];
    consoleErrors = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Uint8Array | string) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Uint8Array | string) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((...data: unknown[]) => {
      consoleErrors.push(data);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    if (previousLogFile === undefined) {
      delete process.env.AGENT_PRESENCE_LOG_FILE;
    } else {
      process.env.AGENT_PRESENCE_LOG_FILE = previousLogFile;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('ends through the generic CLI catch: message on stderr, exit code 1, nothing on stdout', async () => {
    process.argv = [...process.argv.slice(0, 2), 'hook', '--source', 'codex', '--event', 'Heartbeat'];

    // src/cli.ts starts the run on import and does not expose its promise.
    // Both possible endings write output (the generic catch to stderr, the
    // load-failure fallback `{}` to stdout), so the first write marks the end.
    await import('../src/cli.js');
    await vi.waitFor(() => {
      expect(consoleErrors.length + stdoutWrites.length).toBeGreaterThan(0);
    });

    expect(consoleErrors).toEqual([['hook command failed']]);
    expect(process.exitCode).toBe(1);
    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites).toEqual([]);
    expect(existsSync(logFile)).toBe(false);
  });
});
