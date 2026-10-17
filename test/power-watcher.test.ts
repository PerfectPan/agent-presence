import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { buildPowerEventWatcherSwift, buildPowerWatcherPlist, buildPowerWatcherScript } from '../src/power-watcher.js';

const execFileAsync = promisify(execFile);

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
      scriptPath: '/fake-home/.agent-presence/power-watch.sh'
    });
    const script = buildPowerWatcherScript({
      pathEntries: ['/fake-home/.nvm/versions/node/v24.8.0/bin'],
      powerEventWatcherPath: '/fake-home/.agent-presence/power-watch.swift',
      logPath: '/fake-home/.agent-presence/power-watch.log'
    });
    const swift = buildPowerEventWatcherSwift({
      logPath: '/fake-home/.agent-presence/power-watch.log'
    });

    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('work.rivus.agent-presence.power-watch');
    expect(plist).toContain('/fake-home/.agent-presence/power-watch.sh');
    expect(script).toContain('trap cleanup TERM HUP INT EXIT');
    expect(script).toContain('export PATH="/fake-home/.nvm/versions/node/v24.8.0/bin:$PATH"');
    expect(script).toContain('/usr/bin/swift "/fake-home/.agent-presence/power-watch.swift"');
    expect(script).toContain('5242880');
    expect(script).toContain('tail -c 1048576');
    expect(swift).toContain('NSWorkspace.willSleepNotification');
    expect(swift).toContain('NSWorkspace.screensDidSleepNotification');
    expect(swift).toContain('NSWorkspace.didWakeNotification');
    expect(swift).toContain('/fake-home/.agent-presence/power-watch.log');
    expect(swift).toContain('86_400');
  });

  it('generates watcher artifacts with an absolute CLI path', () => {
    withAbsoluteCliPath(() => {
      const script = buildPowerWatcherScript({
        pathEntries: ['/fake-home/.nvm/versions/node/v24.8.0/bin'],
        powerEventWatcherPath: '/fake-home/.agent-presence/power-watch.swift'
      });
      const swift = buildPowerEventWatcherSwift();

      expect(script).not.toContain('npx');
      expect(script).toContain('/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js');
      expect(swift).not.toContain('npx');
      expect(swift).toContain('/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js');
    });
  });

  async function useOversizedLog(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-power-watch-test-'));
    const logPath = join(tempDir, 'power-watch.log');
    const lines = Array.from({ length: 6_200 }, (_, index) => `sequence=${index} payload=${'x'.repeat(1_000)}\n`).join(
      ''
    );
    await writeFile(logPath, lines, { mode: 0o600 });
    return logPath;
  }

  it.runIf(process.platform === 'darwin')(
    'compacts the shell watcher log in place to recent bytes',
    async () => {
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
    },
    20_000
  );

  it.runIf(process.platform === 'darwin')(
    'runs generated Swift log retention behavior with the Swift toolchain',
    async ({ signal }) => {
      const directory = await mkdtemp(join(tmpdir(), 'agent-presence-power-watch-test-'));
      tempDir = directory;
      const retainedBytes = 1024 * 1024;

      async function writeLog(name: string, contents: Buffer) {
        const logPath = join(directory, name);
        await writeFile(logPath, contents, { mode: 0o600 });
        return { logPath, contents, before: await stat(logPath) };
      }

      const multiLineLog = await writeLog(
        'multi-line.log',
        Buffer.from(
          Array.from({ length: 6_200 }, (_, index) => `sequence=${index} payload=${'x'.repeat(1_000)}\n`).join('')
        )
      );
      const singleLineLog = await writeLog('single-line.log', Buffer.alloc(6 * 1024 * 1024, 'x'));
      const unreadableLog = await writeLog('unreadable.log', Buffer.alloc(6 * 1024 * 1024, 'u'));
      const atLimitLog = await writeLog('at-limit.log', Buffer.alloc(5 * 1024 * 1024, 'a'));
      const missingLogPath = join(directory, 'missing.log');
      const scenarios = [
        multiLineLog.logPath,
        singleLineLog.logPath,
        unreadableLog.logPath,
        missingLogPath,
        atLimitLog.logPath
      ].map((logPath) => {
        const swift = buildPowerEventWatcherSwift({ logPath });
        const maintenanceStart = swift.indexOf('let watcherLogPath');
        const maintenanceEnd = swift.indexOf('func resetPresence');
        expect(maintenanceStart).toBeGreaterThan(0);
        expect(maintenanceEnd).toBeGreaterThan(maintenanceStart);
        return `do {\n${swift.slice(maintenanceStart, maintenanceEnd)}pruneWatcherLog()\n}\n`;
      });
      const sourcePath = join(directory, 'prune-logs.swift');
      // The Swift toolchain verifies actual file I/O; maintenance only needs Foundation, so avoid compiling AppKit.
      await writeFile(sourcePath, `import Foundation\n${scenarios.join('\n')}`);

      await chmod(unreadableLog.logPath, 0o000);
      try {
        await execFileAsync('/usr/bin/swift', [sourcePath], { signal, killSignal: 'SIGKILL' });
      } finally {
        await chmod(unreadableLog.logPath, unreadableLog.before.mode & 0o777);
      }

      for (const log of [multiLineLog, singleLineLog]) {
        const after = await stat(log.logPath);
        expect(after.ino).toBe(log.before.ino);
        expect(after.size).toBe(retainedBytes);
        expect((await readFile(log.logPath)).equals(log.contents.subarray(-retainedBytes))).toBe(true);
      }
      for (const log of [unreadableLog, atLimitLog]) {
        const after = await stat(log.logPath);
        expect(after.ino).toBe(log.before.ino);
        expect(after.size).toBe(log.before.size);
        expect((await readFile(log.logPath)).equals(log.contents)).toBe(true);
      }
      await expect(stat(missingLogPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    20_000
  );

  it.runIf(process.platform === 'darwin')(
    'leaves the shell watcher log untouched when retention cannot read it',
    async () => {
      const logPath = await useOversizedLog();
      const original = await stat(logPath);
      const script = buildPowerWatcherScript({ logPath });
      const preambleEnd = script.indexOf('watcher_pid=""');
      expect(preambleEnd).toBeGreaterThan(0);
      await chmod(logPath, 0o000);
      try {
        await execFileAsync('/bin/zsh', ['-c', `${script.slice(0, preambleEnd)}prune_log\n`]);
        expect((await stat(logPath)).size).toBe(original.size);
      } finally {
        await chmod(logPath, 0o600);
      }
    },
    20_000
  );

  it.runIf(process.platform === 'darwin')(
    'treats a missing shell watcher log as a no-op',
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-power-watch-test-'));
      const logPath = join(tempDir, 'missing.log');
      const script = buildPowerWatcherScript({ logPath });
      const preambleEnd = script.indexOf('watcher_pid=""');
      expect(preambleEnd).toBeGreaterThan(0);
      await execFileAsync('/bin/zsh', ['-c', `${script.slice(0, preambleEnd)}prune_log\n`]);

      await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    20_000
  );
});
