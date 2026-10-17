import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { doctor, inventory, verify, type Bundle } from '@rivus/agent-kit/harness';
import { transformWithOxc } from 'vite-plus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as z from 'zod/mini';
import { setup as setupCommand } from '../src/cli/commands/setup.js';
import { installFixtureRuntime } from './runtime-support.js';
import { uninstall } from '../src/cli/commands/uninstall.js';
import { createPresenceBundle, PRESENCE_AGENTS } from '../src/harness/bundle.js';
import { isDisabled, readWorkerVersion } from '../src/queue/files.js';
import { stopWorker } from '../src/queue/takeover.js';
import { listQueue } from '../src/queue/reader.js';
import {
  installPreviousRelease,
  buildOpenCodePluginSource,
  isAgentSignatureCommand,
  previousReleasePaths,
  type PreviousReleaseCommandMode
} from './fixtures/previous-release.js';
import { AGENT_HOME_VARIABLES, createHarnessFixture, HARNESS_NOW, type HarnessFixture } from './harness-support.js';
import { eventBody, fakeEffects, readState, recordAt, virtualTime } from './queue-support.js';

const setup: typeof setupCommand = (args, takeover, layer, options) =>
  setupCommand(args, takeover, layer, { runNpm: installFixtureRuntime, ...options });

const boundary = vi.hoisted(() => ({
  process: vi.fn<() => never>(() => {
    throw new Error('A downgrade acceptance test must not execute a process');
  }),
  setupScripts: vi.fn<typeof import('../src/setup.js').runSetupScripts>(),
  uninstallScripts: vi.fn<typeof import('../src/setup.js').runUninstallScripts>(),
  credential: vi.fn<typeof import('../src/secret.js').readCredential>(),
  login: vi.fn<typeof import('../src/cli/commands/login.js').login>(),
  publish: vi.fn<typeof import('../src/cli/magic-builder-setup.js').publishMagicBuilderFaas>(),
  finish: vi.fn<typeof import('../src/cli/ui.js').finishOutro>(),
  info: vi.fn<typeof import('../src/cli/ui.js').showInfo>()
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: boundary.process,
  spawnSync: boundary.process,
  execFile: boundary.process,
  execFileSync: boundary.process,
  exec: boundary.process,
  execSync: boundary.process
}));
vi.mock('../src/setup.js', () => ({
  LINUX_WATCHER_SKIP_MESSAGE: 'linux watcher skipped',
  platformUninstallScriptNames: () => ['uninstall-dsh-plugin.js', 'uninstall-shutdown-watcher.js'],
  runSetupScripts: boundary.setupScripts,
  runUninstallScripts: boundary.uninstallScripts
}));
vi.mock('../src/migration.js', () => ({
  cleanupMigratedLegacyHome: async () => ({ from: '', to: '', removed: [] }),
  hasLegacyHomeToMigrate: async () => false,
  migrateLegacyHome: vi.fn<typeof import('../src/migration.js').migrateLegacyHome>()
}));
vi.mock('../src/secret.js', () => ({
  readCredential: boundary.credential,
  deleteCredential: boundary.process
}));
vi.mock('../src/cli/credential.js', () => ({ hasCredential: async () => false }));
vi.mock('../src/cli/commands/login.js', () => ({ login: boundary.login }));
vi.mock('../src/cli/magic-builder-setup.js', () => ({
  MAGIC_TOKEN_HELP: '',
  publishMagicBuilderFaas: boundary.publish
}));
vi.mock('../src/cli/commands/url.js', () => ({ resolveSignatureUrl: boundary.process }));
vi.mock('../src/platform.js', () => ({ isMacOS: () => false }));
vi.mock('../src/cli/ui.js', () => ({
  startIntro: vi.fn<typeof import('../src/cli/ui.js').startIntro>(),
  createSpinner: () => ({ start: () => undefined, stop: () => undefined, error: () => undefined }),
  finishOutro: boundary.finish,
  isInteractiveTerminal: () => false,
  promptConfirm: boundary.process,
  promptText: boundary.process,
  promptSelect: boundary.process,
  showInfo: boundary.info,
  showNote: vi.fn<typeof import('../src/cli/ui.js').showNote>()
}));

const OLD_EVENTS = {
  'claude-code': [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'StopFailure',
    'SessionEnd',
    'SubagentStart',
    'SubagentStop'
  ],
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'],
  'gemini-cli': ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']
};
const OLD_OPENCODE_EVENTS = [
  'session.created',
  'command.executed',
  'file.edited',
  'message.part.updated',
  'message.updated',
  'permission.asked',
  'permission.replied',
  'session.diff',
  'session.status',
  'session.updated',
  'todo.updated',
  'tool.execute.after',
  'tool.execute.before',
  'session.deleted',
  'session.error',
  'session.idle'
];
const OLD_PI_EVENTS = [
  'before_agent_start',
  'turn_start',
  'tool_execution_start',
  'tool_execution_end',
  'agent_end',
  'session_shutdown'
];
const hookDocument = z.object({
  theme: z.optional(z.string()),
  hooks: z.record(z.string(), z.array(z.object({ hooks: z.array(z.object({ command: z.string() })) })))
});

let fixture: HarnessFixture;
let errors: string[];
let savedExitCode: typeof process.exitCode;

beforeEach(async () => {
  fixture = await createHarnessFixture();
  vi.stubEnv('HOME', fixture.home);
  for (const key of Object.keys(process.env)) {
    if (
      /^(AGENT_PRESENCE_|AGENT_SIGNATURE_)/.test(key) ||
      /^(CLAUDE|CODEX|GEMINI|GROK|PI|OPENCODE)_.*SESSION/.test(key)
    ) {
      vi.stubEnv(key, undefined);
    }
  }
  for (const key of [...AGENT_HOME_VARIABLES, 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'DSH_HOME', 'CODEX_THREAD_ID']) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv('AGENT_PRESENCE_HOOK_COMMAND', undefined);
  vi.stubEnv('AGENT_PRESENCE_HOME', fixture.presenceHome);
  vi.stubEnv('AGENT_PRESENCE_CONFIG_FILE', join(fixture.presenceHome, 'config.json'));
  await mkdir(fixture.presenceHome, { recursive: true });
  await writeFile(join(fixture.presenceHome, 'config.json'), '{"provider":"feishu-signature"}');
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(HARNESS_NOW);
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => errors.push(parts.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  boundary.setupScripts.mockResolvedValue([]);
  boundary.uninstallScripts.mockImplementation(async ({ scriptNames = [] } = {}) =>
    scriptNames.map((scriptName) => ({ scriptName, scriptPath: `/dist/scripts/${scriptName}` }))
  );
  boundary.credential.mockResolvedValue(undefined);
  boundary.login.mockImplementation(boundary.process);
  boundary.publish.mockImplementation(boundary.process);
});

afterEach(async () => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.dispose();
});

function installedMarkers(bundle: Bundle): string[] {
  return bundle.artifacts.flatMap((artifact) =>
    artifact.type === 'hooks' ? PRESENCE_AGENTS.map((agent) => artifact.command.replaceAll('{agent}', agent)) : []
  );
}

async function seedUnrelatedSettings(): Promise<void> {
  const paths = previousReleasePaths(fixture.home);
  for (const path of [paths.claudeSettings, paths.geminiSettings, paths.opencodeConfig, paths.piSettings]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"theme":"keep-theme"}\n');
  }
  await mkdir(join(fixture.home, '.codex'), { recursive: true });
  await writeFile(join(fixture.home, '.codex/config.toml'), '# keep comment\nmodel = "keep-model"\n');
}

async function installCurrent(mode: PreviousReleaseCommandMode): Promise<Bundle> {
  vi.stubEnv('AGENT_PRESENCE_CLI_PATH', '/work/presence/dist/src/cli.js');
  await seedUnrelatedSettings();
  await setup(['--skip-login', '--provider', 'feishu-signature', '--yes', '--hook-command', mode], {}, fixture.layer);
  expect(errors).toEqual([]);
  expect(boundary.finish).toHaveBeenLastCalledWith('setup: ok');
  expect(boundary.setupScripts).toHaveBeenCalledOnce();
  const bundle = createPresenceBundle(fixture.presenceHome);
  const report = await fixture.run(verify('agent-presence', { bundle, agents: PRESENCE_AGENTS }));
  expect(report.artifacts).toHaveLength(8);
  expect(report.artifacts.map(({ status }) => status)).toEqual(Array(8).fill('in-sync'));
  return bundle;
}

async function expectNoCurrentInstallation(bundle: Bundle): Promise<void> {
  expect(await fixture.run(inventory())).toMatchObject({ entries: [], pending: [] });
  expect(await fixture.run(verify('agent-presence', { agents: PRESENCE_AGENTS }))).toEqual({
    artifacts: [],
    acknowledged: []
  });
  const checks = await fixture.run(
    doctor({ owner: 'agent-presence', agents: PRESENCE_AGENTS, markers: installedMarkers(bundle) })
  );
  expect(checks).toHaveLength(2);
  expect(checks.map(({ name, status }) => ({ name, status }))).toEqual([
    { name: 'ledger', status: 'ok' },
    { name: 'lock', status: 'ok' }
  ]);
  expect(checks[0]?.message).toMatch(/^revision \d+, 0 entries$/);
  const desired = await fixture.run(verify('agent-presence', { bundle, agents: PRESENCE_AGENTS }));
  expect(desired.artifacts).toHaveLength(8);
  expect(desired.artifacts.map(({ status }) => status)).toEqual(Array(8).fill('missing'));
  for (const path of [
    join(fixture.presenceHome, 'bin/agent-presence'),
    join(fixture.home, '.claude/skills/agent-presence'),
    join(fixture.home, '.codex/plugins/agent-presence'),
    join(fixture.home, '.codex/plugins/cache/agent-presence/agent-presence/local'),
    join(fixture.home, '.gemini/extensions/agent-presence'),
    join(fixture.home, '.grok/hooks/agent-presence.json'),
    previousReleasePaths(fixture.home).opencodePlugin,
    previousReleasePaths(fixture.home).piExtension
  ]) {
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
}

interface Emission {
  command: string;
  args: string[];
}

async function expectOldBridgeEvents(mode: PreviousReleaseCommandMode): Promise<void> {
  const paths = previousReleasePaths(fixture.home);
  const emissions: Emission[] = [];
  const commandParts =
    mode === 'npx'
      ? ['npx', '--yes', '--registry=https://registry.npmjs.org', '@rivus/agent-presence@0.9.0']
      : ['/usr/bin/node', '/work/checkout/dist/src/cli.js'];
  const emit = (command: string, args: string[]) => {
    emissions.push({ command, args });
    return { stdin: { end: () => undefined }, on: () => undefined };
  };
  const context = { spawn: emit, spawnSync: emit, process: { env: {}, cwd: () => '/work/project' } };
  const pluginText = await readFile(paths.opencodePlugin, 'utf8');
  const plugin = runInNewContext(
    pluginText
      .replace('import { spawn, spawnSync } from "node:child_process"', '')
      .replace('export const AgentSignaturePlugin', 'const AgentSignaturePlugin')
      .replace('export default AgentSignaturePlugin', 'AgentSignaturePlugin'),
    { ...context }
  ) as (ctx: { directory: string }) => Promise<{
    event(input: { event: { type: string; properties: { sessionID: string } } }): Promise<void>;
    'tool.execute.before'(input: object): Promise<void>;
    'tool.execute.after'(input: object): Promise<void>;
  }>;
  const installedPlugin = await plugin({ directory: '/work/project' });
  for (const type of OLD_OPENCODE_EVENTS) {
    const before = emissions.length;
    await installedPlugin.event({ event: { type, properties: { sessionID: 'old-session' } } });
    expect(emissions.slice(before), `opencode ${type}`).toHaveLength(1);
  }
  for (const event of ['tool.execute.before', 'tool.execute.after'] as const) {
    const before = emissions.length;
    await installedPlugin[event]({ sessionID: 'old-session' });
    expect(emissions.slice(before), `opencode ${event} callback`).toHaveLength(1);
  }
  const callbacks = new Map<string, Array<(event: object, ctx: object) => Promise<void>>>();
  const transformed = await transformWithOxc(await readFile(paths.piExtension, 'utf8'), 'previous-release.ts', {
    sourcemap: false
  });
  const extension = runInNewContext(
    `${transformed.code.replace(/import \{[^}]+\} from "node:child_process";?/, '').replace('export default function', '(function')}\n)`,
    { ...context }
  ) as (pi: { on(event: string, callback: (event: object, ctx: object) => Promise<void>): void }) => void;
  extension({ on: (event, callback) => callbacks.set(event, [...(callbacks.get(event) ?? []), callback]) });
  expect([...callbacks.keys()]).toEqual(OLD_PI_EVENTS);
  for (const event of OLD_PI_EVENTS) {
    expect(callbacks.get(event), `pi ${event} registration`).toHaveLength(1);
    const before = emissions.length;
    await callbacks.get(event)?.[0]?.(
      {},
      { cwd: '/work/project', sessionManager: { getSessionId: () => 'old-session' } }
    );
    expect(emissions.slice(before), `pi ${event}`).toHaveLength(1);
  }
  for (const emission of emissions) {
    expect([emission.command, ...emission.args].slice(0, commandParts.length)).toEqual(commandParts);
    expect(emission.args).toContain('hook');
    expect(emission.args).not.toContain('--agent');
    expect(JSON.stringify(emission)).not.toContain(fixture.presenceHome);
  }
}

describe('documented harness downgrade order', () => {
  it.each(['npx', 'absolute'] as const)(
    'removes the current installation before restoring each old %s hook once',
    async (mode) => {
      const bundle = await installCurrent(mode);
      const installed = await fixture.run(inventory());
      expect(installed.entries).toHaveLength(8);

      await uninstall([], {}, fixture.layer);

      const removed = boundary.info.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith('uninstall artifact:'));
      expect(removed).toHaveLength(8);
      expect(removed.every((message) => /^uninstall artifact: remove \((delete|unregister)\): /.test(message))).toBe(
        true
      );
      expect(boundary.info.mock.calls.filter(([message]) => message.startsWith('uninstall kept:'))).toEqual([]);
      expect(boundary.finish).toHaveBeenLastCalledWith('uninstall: ok');
      await expectNoCurrentInstallation(bundle);
      expect(await readFile(join(fixture.home, '.codex/config.toml'), 'utf8')).toBe(
        '# keep comment\nmodel = "keep-model"\n'
      );

      const statePath = join(fixture.presenceHome, 'state.json');
      const vt = virtualTime(HARNESS_NOW);
      const fake = fakeEffects();
      const startWorker = vi.fn<() => void>();
      await recordAt(statePath, HARNESS_NOW, eventBody('SessionStart', 'pending-before-downgrade'));
      await stopWorker(statePath, {
        clock: vt.clock,
        monotonic: vt.monotonic,
        delay: vt.delay,
        effects: fake.effects,
        startWorker
      });
      expect(await isDisabled(statePath)).toBe(true);
      expect(await readWorkerVersion(statePath)).toBe(0);
      expect((await listQueue(statePath)).records).toEqual([]);
      expect((await readState(statePath)).sessions['pending-before-downgrade']).toMatchObject({ status: 'running' });
      expect(startWorker).not.toHaveBeenCalled();

      await installPreviousRelease({ homeDir: fixture.home, commandMode: mode });

      const paths = previousReleasePaths(fixture.home);
      for (const [agent, path] of [
        ['claude-code', paths.claudeSettings],
        ['codex', paths.codexHooks],
        ['gemini-cli', paths.geminiSettings]
      ] as const) {
        const document = hookDocument.parse(JSON.parse(await readFile(path, 'utf8')));
        expect(Object.keys(document.hooks)).toEqual(OLD_EVENTS[agent]);
        for (const [event, groups] of Object.entries(document.hooks)) {
          const commands = groups
            .flatMap((group) => group.hooks)
            .filter(({ command }) => isAgentSignatureCommand(command));
          expect(commands, `${agent} ${event}`).toHaveLength(1);
          expect(commands[0]?.command).toContain(`--event ${event}`);
          expect(commands[0]?.command).toContain(
            mode === 'npx' ? '@rivus/agent-presence@0.9.0' : '/work/checkout/dist/src/cli.js hook'
          );
          expect(commands[0]?.command).not.toContain(fixture.presenceHome);
        }
        if (agent !== 'codex') {
          expect(document.theme).toBe('keep-theme');
        }
      }
      expect(
        z
          .object({ theme: z.string(), plugin: z.array(z.string()) })
          .parse(JSON.parse(await readFile(paths.opencodeConfig, 'utf8')))
      ).toEqual({ theme: 'keep-theme', plugin: ['./plugins/agent-presence.js'] });
      expect(
        z
          .object({ theme: z.string(), extensions: z.optional(z.array(z.string())) })
          .parse(JSON.parse(await readFile(paths.piSettings, 'utf8')))
      ).toEqual({ theme: 'keep-theme' });
      await expectOldBridgeEvents(mode);
      expect(await fixture.run(inventory())).toMatchObject({ entries: [], pending: [] });
      const remainingDesired = await fixture.run(verify('agent-presence', { bundle, agents: PRESENCE_AGENTS }));
      expect(remainingDesired.artifacts.map(({ status }) => status)).toEqual([
        ...Array(6).fill('missing'),
        'unmanaged',
        'unmanaged'
      ]);
      expect(
        remainingDesired.artifacts.filter(({ status }) => status === 'unmanaged').map(({ locator }) => locator.path)
      ).toEqual([await realpath(paths.opencodePlugin), await realpath(paths.piExtension)]);
      await expect(stat(join(fixture.presenceHome, 'bin/agent-presence'))).rejects.toMatchObject({ code: 'ENOENT' });
      // The previous release did not install Grok; it may still read the old Claude settings as its own agent behavior.
      await expect(stat(join(fixture.home, '.grok/hooks/agent-presence.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      expect(boundary.process).not.toHaveBeenCalled();
      expect(boundary.login).not.toHaveBeenCalled();
      expect(boundary.publish).not.toHaveBeenCalled();
      expect(fixture.processCalls).toEqual([]);
      expect(errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    }
  );

  it.each(['npx', 'absolute'] as const)(
    'old %s setup overwrites the ledgered opencode bridge and explicit legacy markers expose command overlap',
    async (mode) => {
      const bundle = await installCurrent(mode);
      const paths = previousReleasePaths(fixture.home);
      const installed = await fixture.run(inventory());
      const currentBridge = await readFile(paths.opencodePlugin, 'utf8');
      await expect(installPreviousRelease({ homeDir: fixture.home, commandMode: mode })).rejects.toThrow(
        `refusing to overwrite ${paths.piExtension}: it is not managed by @rivus/agent-presence. Delete or rename that file, then rerun setup.`
      );
      const oldBridge = await readFile(paths.opencodePlugin, 'utf8');
      expect(oldBridge).not.toBe(currentBridge);
      expect(oldBridge).toBe(
        buildOpenCodePluginSource(
          mode === 'npx'
            ? ['npx', '--yes', '--registry=https://registry.npmjs.org', '@rivus/agent-presence@0.9.0']
            : ['/usr/bin/node', '/work/checkout/dist/src/cli.js']
        )
      );
      expect(await fixture.run(inventory())).toEqual(installed);
      const report = await fixture.run(verify('agent-presence', { bundle, agents: PRESENCE_AGENTS }));
      expect(report.artifacts.filter(({ agents }) => agents.includes('opencode'))).toMatchObject([
        { status: 'user-modified', locator: { path: await realpath(paths.opencodePlugin) } }
      ]);
      const currentOnly = await fixture.run(
        doctor({ owner: 'agent-presence', agents: PRESENCE_AGENTS, markers: installedMarkers(bundle) })
      );
      expect(currentOnly.filter(({ name }) => name === 'duplicate-hook')).toEqual([]);
      // Absolute old commands need the test-only dist/src marker; production doctor supplies neither legacy marker.
      const checks = await fixture.run(
        doctor({
          owner: 'agent-presence',
          agents: PRESENCE_AGENTS,
          markers: [...installedMarkers(bundle), '@rivus/agent-presence', 'dist/src/cli.js hook']
        })
      );
      const duplicates = checks.filter(({ name }) => name === 'duplicate-hook');
      // Doctor reads command-hook files. It does not diagnose opencode or Pi bridge registrations.
      const expectedEvents = {
        'claude-code': OLD_EVENTS['claude-code'],
        codex: OLD_EVENTS.codex,
        'gemini-cli': ['SessionStart', 'SessionEnd'],
        grok: OLD_EVENTS['claude-code']
      };
      expect(duplicates.map(({ status, message }) => ({ status, message }))).toEqual(
        Object.entries(expectedEvents).flatMap(([agent, events]) =>
          events.map((event) => ({ status: 'warn', message: `${agent} runs 2 hooks of one application for ${event}` }))
        )
      );
      expect(boundary.process).not.toHaveBeenCalled();
      expect(fixture.processCalls).toEqual([]);
    }
  );
});
