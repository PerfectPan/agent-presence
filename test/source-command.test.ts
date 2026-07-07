import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { source } from '../src/cli/commands/source.js';
import { resetSourcePluginCacheForTests } from '../src/sources.js';

let workDir: string;
let binDir: string;
let configPath: string;
let previousPath: string | undefined;
let previousExitCode: number | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

/**
 * A fake `npm` on PATH that materializes the package under the prefix's
 * node_modules the way a real install would, so the command runs offline.
 * `declaredId` is the source id the installed module exports (to exercise the
 * --id mismatch guard).
 */
function writeFakeNpm(pkgName: string, version: string, declaredId: string): void {
  const script = `#!/bin/sh
if [ "$1" = "install" ]; then
  DIR="$PWD/node_modules/${pkgName}"
  mkdir -p "$DIR"
  printf '{"name":"${pkgName}","version":"${version}","type":"module","main":"index.mjs"}' > "$DIR/package.json"
  printf 'export default { id: "${declaredId}", resolveHookContext(p){ return { sessionId: p.session_id }; } };' > "$DIR/index.mjs"
fi
exit 0
`;
  const npmPath = join(binDir, 'npm');
  writeFileSync(npmPath, script, { mode: 0o755 });
  chmodSync(npmPath, 0o755);
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'agent-presence-source-cmd-'));
  binDir = join(workDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  configPath = join(workDir, 'config.json');
  writeFileSync(configPath, '{}', { mode: 0o600 });

  process.env.AGENT_PRESENCE_HOME = workDir;
  process.env.AGENT_PRESENCE_CONFIG_FILE = configPath;
  process.env.AGENT_PRESENCE_PLUGINS_DIR = join(workDir, 'plugins');
  process.env.AGENT_PRESENCE_LOG_FILE = join(workDir, 'log.txt');
  process.env.AGENT_PRESENCE_NO_PROMPTS = '1';
  previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;

  previousExitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetSourcePluginCacheForTests();
});

afterEach(async () => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  process.exitCode = previousExitCode;
  process.env.PATH = previousPath;
  delete process.env.AGENT_PRESENCE_HOME;
  delete process.env.AGENT_PRESENCE_CONFIG_FILE;
  delete process.env.AGENT_PRESENCE_PLUGINS_DIR;
  delete process.env.AGENT_PRESENCE_LOG_FILE;
  delete process.env.AGENT_PRESENCE_NO_PROMPTS;
  resetSourcePluginCacheForTests();
  await rm(workDir, { recursive: true, force: true });
});

describe('source add', () => {
  it('installs, validates, and records a config entry', async () => {
    writeFakeNpm('agent-presence-myagent', '1.2.3', 'myagent');
    await source(['add', 'agent-presence-myagent', '--yes']);

    const config = await readConfig();
    expect(config).toEqual({
      plugins: { sources: { myagent: { handler: 'agent-presence-myagent' } } }
    });
    expect(process.exitCode).toBeFalsy();
  });

  it('records under an explicit --id that matches the declared id', async () => {
    writeFakeNpm('agent-presence-myagent', '1.0.0', 'myagent');
    await source(['add', 'agent-presence-myagent', '--id', 'myagent', '--yes']);
    const config = await readConfig();
    expect(config.plugins).toEqual({ sources: { myagent: { handler: 'agent-presence-myagent' } } });
  });

  it('rejects a --id that does not match the package declared id, writing nothing', async () => {
    writeFakeNpm('agent-presence-myagent', '1.0.0', 'realid');
    await source(['add', 'agent-presence-myagent', '--id', 'wrongid', '--yes']);

    // The mismatch would produce a source that never resolves at hook time, so
    // add refuses and leaves config untouched.
    expect(await readConfig()).toEqual({});
    expect(process.exitCode).toBe(1);
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/does not match/);
  });

  it('does not install without confirmation in a non-interactive shell', async () => {
    writeFakeNpm('agent-presence-myagent', '1.0.0', 'myagent');
    await source(['add', 'agent-presence-myagent']); // no --yes, prompts return false
    expect(await readConfig()).toEqual({});
    expect(process.exitCode).toBe(1);
  });

  it('errors when no package spec is given', async () => {
    await source(['add', '--yes']);
    expect(process.exitCode).toBe(1);
  });
});

describe('source list', () => {
  it('prints the merged table as JSON including a configured source', async () => {
    writeFakeNpm('agent-presence-myagent', '1.0.0', 'myagent');
    await source(['add', 'agent-presence-myagent', '--yes']);
    logSpy.mockClear();

    await source(['list']);
    const printed = logSpy.mock.calls.flat().join('\n');
    const table = JSON.parse(printed) as { id: string; origin: string; kind: string }[];
    expect(table.find((s) => s.id === 'codex')).toMatchObject({ origin: 'default', kind: 'builtin' });
    expect(table.find((s) => s.id === 'myagent')).toMatchObject({ origin: 'config', kind: 'handler' });
  });
});

describe('source remove', () => {
  it('removes a configured source entry', async () => {
    writeFakeNpm('agent-presence-myagent', '1.0.0', 'myagent');
    await source(['add', 'agent-presence-myagent', '--yes']);
    expect((await readConfig()).plugins).toBeTruthy();

    await source(['remove', 'myagent']);
    expect(await readConfig()).toEqual({});
    expect(process.exitCode).toBeFalsy();
  });

  it('refuses to remove a built-in id (not a config entry)', async () => {
    await source(['remove', 'codex']);
    expect(process.exitCode).toBe(1);
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/no configured source/);
  });
});
