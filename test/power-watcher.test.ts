import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPowerEventWatcherSwift,
  buildPowerWatcherPlist,
  buildPowerWatcherScript
} from '../src/power-watcher.js';

const execFileAsync = promisify(execFile);

describe('power watcher artifacts', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('generates the launch agent, reset hooks, and daily log retention policy', () => {
    const plist = buildPowerWatcherPlist({
      label: 'work.rivus.agent-presence.power-watch',
      scriptPath: '/Users/example/.agent-presence/power-watch.sh'
    });
    const script = buildPowerWatcherScript({
      pathEntries: ['/Users/example/.nvm/versions/node/v24.8.0/bin'],
      powerEventWatcherPath: '/Users/example/.agent-presence/power-watch.swift',
      logPath: '/Users/example/.agent-presence/power-watch.log'
    });
    const swift = buildPowerEventWatcherSwift({
      logPath: '/Users/example/.agent-presence/power-watch.log'
    });

    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('work.rivus.agent-presence.power-watch');
    expect(plist).toContain('/Users/example/.agent-presence/power-watch.sh');
    expect(script).toContain('trap cleanup TERM HUP INT EXIT');
    expect(script).toContain('export PATH="/Users/example/.nvm/versions/node/v24.8.0/bin:$PATH"');
    expect(script).toContain('/usr/bin/swift "/Users/example/.agent-presence/power-watch.swift"');
    expect(script).toContain('5242880');
    expect(script).toContain('tail -c 1048576');
    expect(swift).toContain('NSWorkspace.willSleepNotification');
    expect(swift).toContain('NSWorkspace.screensDidSleepNotification');
    expect(swift).toContain('NSWorkspace.didWakeNotification');
    expect(swift).toContain('/Users/example/.agent-presence/power-watch.log');
    expect(swift).toContain('86_400');
  });

  it('generates watcher artifacts with an absolute CLI path', () => {
    withAbsoluteCliPath(() => {
      const script = buildPowerWatcherScript({
        pathEntries: ['/Users/example/.nvm/versions/node/v24.8.0/bin'],
        powerEventWatcherPath: '/Users/example/.agent-presence/power-watch.swift'
      });
      const swift = buildPowerEventWatcherSwift();

      expect(script).not.toContain('npx');
      expect(script).toContain('/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js');
      expect(swift).not.toContain('npx');
      expect(swift).toContain('/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js');
    });
  });

  it.runIf(process.platform === 'darwin')('compacts the shell watcher log in place to recent bytes', async () => {
    const logPath = await useOversizedLog();
    const before = await stat(logPath);
    const script = buildPowerWatcherScript({ logPath });
    const preambleEnd = script.indexOf('watcher_pid=""');
    expect(preambleEnd).toBeGreaterThan(0);
    const pruneLog = () => execFileAsync('/bin/zsh', ['-c', `${script.slice(0, preambleEnd)}prune_log\n`]);

    await pruneLog();

    const after = await stat(logPath);
    const contents = await readFile(logPath, 'utf8');
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBeLessThan(2 * 1024 * 1024);
    expect(contents).not.toContain('sequence=0 ');
    expect(contents).toContain('sequence=6199 ');

    await writeFile(logPath, 'x'.repeat(6 * 1024 * 1024));
    const singleLineBefore = await stat(logPath);
    await pruneLog();
    const singleLineAfter = await stat(logPath);
    expect(singleLineAfter.ino).toBe(singleLineBefore.ino);
    expect(singleLineAfter.size).toBe(1024 * 1024);
    expect(await readFile(logPath, 'utf8')).toBe('x'.repeat(1024 * 1024));
  }, 20_000);

  it.runIf(process.platform === 'darwin')('compacts the Swift watcher log in place to recent bytes', async () => {
    const logPath = await useOversizedLog();
    const before = await stat(logPath);
    const swift = buildPowerEventWatcherSwift({ logPath });
    const maintenanceEnd = swift.indexOf('func resetPresence');
    expect(maintenanceEnd).toBeGreaterThan(0);
    const sourcePath = join(tempDir!, 'prune-log.swift');
    await writeFile(sourcePath, `${swift.slice(0, maintenanceEnd)}pruneWatcherLog()\n`);

    await execFileAsync('/usr/bin/swift', [sourcePath]);

    const after = await stat(logPath);
    const contents = await readFile(logPath, 'utf8');
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBeLessThan(2 * 1024 * 1024);
    expect(contents).not.toContain('sequence=0 ');
    expect(contents).toContain('sequence=6199 ');

    await writeFile(logPath, 'x'.repeat(6 * 1024 * 1024));
    const singleLineBefore = await stat(logPath);
    await execFileAsync('/usr/bin/swift', [sourcePath]);
    const singleLineAfter = await stat(logPath);
    expect(singleLineAfter.ino).toBe(singleLineBefore.ino);
    expect(singleLineAfter.size).toBe(1024 * 1024);
    expect(await readFile(logPath, 'utf8')).toBe('x'.repeat(1024 * 1024));
  }, 20_000);

  it.runIf(process.platform === 'darwin')('leaves the watcher log untouched when retention cannot read it', async () => {
    const logPath = await useOversizedLog();
    const original = await stat(logPath);
    const script = buildPowerWatcherScript({ logPath });
    const preambleEnd = script.indexOf('watcher_pid=""');
    expect(preambleEnd).toBeGreaterThan(0);
    const swift = buildPowerEventWatcherSwift({ logPath });
    const maintenanceEnd = swift.indexOf('func resetPresence');
    expect(maintenanceEnd).toBeGreaterThan(0);
    const sourcePath = join(tempDir!, 'prune-unreadable-log.swift');
    await writeFile(sourcePath, `${swift.slice(0, maintenanceEnd)}pruneWatcherLog()\n`);

    await chmod(logPath, 0o000);
    try {
      await execFileAsync('/bin/zsh', ['-c', `${script.slice(0, preambleEnd)}prune_log\n`]);
      await execFileAsync('/usr/bin/swift', [sourcePath]);
      expect((await stat(logPath)).size).toBe(original.size);
    } finally {
      await chmod(logPath, 0o600);
    }
  }, 20_000);

  it.runIf(process.platform === 'darwin')('treats a missing watcher log as a no-op', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-power-watch-test-'));
    const logPath = join(tempDir, 'missing.log');
    const script = buildPowerWatcherScript({ logPath });
    const preambleEnd = script.indexOf('watcher_pid=""');
    expect(preambleEnd).toBeGreaterThan(0);
    await execFileAsync('/bin/zsh', ['-c', `${script.slice(0, preambleEnd)}prune_log\n`]);

    const swift = buildPowerEventWatcherSwift({ logPath });
    const maintenanceEnd = swift.indexOf('func resetPresence');
    expect(maintenanceEnd).toBeGreaterThan(0);
    const sourcePath = join(tempDir, 'prune-missing-log.swift');
    await writeFile(sourcePath, `${swift.slice(0, maintenanceEnd)}pruneWatcherLog()\n`);
    await execFileAsync('/usr/bin/swift', [sourcePath]);

    await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  async function useOversizedLog(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-power-watch-test-'));
    const logPath = join(tempDir, 'power-watch.log');
    const lines = Array.from(
      { length: 6_200 },
      (_, index) => `sequence=${index} payload=${'x'.repeat(1_000)}\n`
    ).join('');
    await writeFile(logPath, lines, { mode: 0o600 });
    return logPath;
  }
});

function withAbsoluteCliPath<T>(fn: () => T): T {
  const previousMode = process.env.AGENT_PRESENCE_HOOK_COMMAND;
  const previousCliPath = process.env.AGENT_PRESENCE_CLI_PATH;
  process.env.AGENT_PRESENCE_HOOK_COMMAND = 'absolute';
  process.env.AGENT_PRESENCE_CLI_PATH = '/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js';
  try {
    return fn();
  } finally {
    if (previousMode === undefined) {
      delete process.env.AGENT_PRESENCE_HOOK_COMMAND;
    } else {
      process.env.AGENT_PRESENCE_HOOK_COMMAND = previousMode;
    }
    if (previousCliPath === undefined) {
      delete process.env.AGENT_PRESENCE_CLI_PATH;
    } else {
      process.env.AGENT_PRESENCE_CLI_PATH = previousCliPath;
    }
  }
}
