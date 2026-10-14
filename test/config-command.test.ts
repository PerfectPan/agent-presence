import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { configureRender } from '../src/cli/commands/config-render.js';
import { printConfig } from '../src/cli/commands/config-show.js';
import { printStatus } from '../src/cli/commands/status.js';
import { source } from '../src/cli/commands/source.js';
import type { AppConfig } from '../src/config.js';
import { owedWorkRemains } from '../src/queue/worker.js';
import { createCommandHarness, TEMPLATES, type CommandHarness } from './queue-command-harness.js';

// Commands on a config with broken entries (issue #106): each run reports the dropped values once on stderr, keeps
// working, and a write command changes only what it is meant to change — the file's other content survives. Each
// test breaks its own paths: the report-once bookkeeping lives for the whole process, so paths stay test-specific.

// A sync inside the debounce interval schedules a detached flush; record it instead of spawning one.
const spawnMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { unref: () => void; on: () => void }>(() => ({
    unref: () => undefined,
    on: () => undefined
  }))
);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock
}));

const publishValueMock = vi.hoisted(() => vi.fn<(value: string) => Promise<void>>());
vi.mock('../src/providers/registry.js', () => ({
  createProvider: () => ({ id: 'feishu-signature', publishValue: publishValueMock })
}));

vi.mock('../src/secret.js', () => ({
  readCredential: vi
    .fn<typeof import('../src/secret.js').readCredential>()
    .mockResolvedValue({ token: 'test-token', slotId: 'test-slot' })
}));

let h: CommandHarness;
let consoleErrors: string[];

async function writeRawConfig(content: unknown): Promise<void> {
  await h.home.writeConfig(content as AppConfig);
}

async function readRawConfig(): Promise<unknown> {
  return JSON.parse(await readFile(join(h.home.dir, 'config.json'), 'utf8'));
}

beforeEach(async () => {
  spawnMock.mockClear();
  publishValueMock.mockReset().mockResolvedValue(undefined);
  h = await createCommandHarness();
  consoleErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    consoleErrors.push(parts.map((part) => String(part)).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

function captureLog(): string[] {
  const printed: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    printed.push(parts.map((part) => String(part)).join(' '));
  });
  return printed;
}

describe('commands report dropped values once', () => {
  it('status succeeds with a broken source entry and prints its warning once across its loads', async () => {
    await writeRawConfig({ provider: 'feishu-signature', render: TEMPLATES, plugins: { sources: { st: null } } });

    await expect(printStatus([], h.takeoverOptions())).resolves.toBeUndefined();

    expect(consoleErrors).toEqual(['config: ignored plugins.sources.st (expected an object)']);
  });

  it('source list resolves the merged table without the broken entry', async () => {
    await writeRawConfig({ plugins: { sources: { ls: null } } });

    const printed = captureLog();
    await source(['list']);

    expect(consoleErrors).toEqual(['config: ignored plugins.sources.ls (expected an object)']);
    const listed = JSON.parse(printed.join('')) as { id: string }[];
    expect(listed.map((entry) => entry.id)).not.toContain('ls');
    expect(listed.map((entry) => entry.id)).toContain('codex');
  });

  it('config show lists the issues, and stays unchanged for a valid config', async () => {
    await writeRawConfig({ render: { many: 5 }, plugins: { sources: { sh: null } }, unknownTop: 1 });

    const printed = captureLog();
    await printConfig();

    const shown = JSON.parse(printed.join('')) as { configIssues?: { path: string; reason: string }[] };
    expect(shown.configIssues).toEqual([
      { path: 'render.many', reason: 'expected a string' },
      { path: 'plugins.sources.sh', reason: 'expected an object' }
    ]);
    expect(consoleErrors).toEqual([
      'config: ignored render.many (expected a string)',
      'config: ignored plugins.sources.sh (expected an object)'
    ]);

    printed.length = 0;
    await writeRawConfig({ provider: 'feishu-signature', render: TEMPLATES });
    await printConfig();
    const valid = JSON.parse(printed.join('')) as { configIssues?: unknown };
    expect('configIssues' in valid).toBe(false);
    expect(consoleErrors).toHaveLength(2);
  });

  it("the worker's loader drops silently", async () => {
    await writeRawConfig({ plugins: { sources: { wk: null } } });

    await expect(owedWorkRemains(h.home.statePath)).resolves.toBe(false);
    expect(consoleErrors).toEqual([]);
  });
});

describe('write commands keep what they did not change', () => {
  it('config render rewrites only its templates over the file as read', async () => {
    await writeRawConfig({
      plugins: { sources: { wr: null } },
      unknownTop: { a: 1 },
      render: { one: 5 }
    });

    await configureRender(['--zero', 'ZERO TEMPLATE']);

    expect(await readRawConfig()).toEqual({
      plugins: { sources: { wr: null } },
      unknownTop: { a: 1 },
      render: { one: 5, zero: 'ZERO TEMPLATE' }
    });
    expect(consoleErrors).toEqual([
      'config: ignored render.one (expected a string)',
      'config: ignored plugins.sources.wr (expected an object)'
    ]);
  });

  it('source remove drops only its entry over the file as read', async () => {
    await writeRawConfig({
      plugins: { sources: { rm: null, keep: { handler: '@scope/keep' } } },
      unknownTop: { a: 1 }
    });

    await source(['remove', 'keep', '--keep-package']);

    expect(await readRawConfig()).toEqual({
      plugins: { sources: { rm: null } },
      unknownTop: { a: 1 }
    });
    expect(consoleErrors).toEqual(['config: ignored plugins.sources.rm (expected an object)']);
  });

  it('source remove reports a broken entry as not configured and leaves the file alone', async () => {
    await writeRawConfig({ plugins: { sources: { nc: null } }, unknownTop: { a: 1 } });
    const before = await readRawConfig();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await source(['remove', 'nc']);
    } finally {
      process.exitCode = previousExitCode;
    }

    expect(consoleErrors).toEqual(['config: ignored plugins.sources.nc (expected an object)']);
    expect(await readRawConfig()).toEqual(before);
  });
});
