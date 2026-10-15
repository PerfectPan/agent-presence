import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { doctor, findLegacy, planInstall, discardPlan, verify } from '@rivus/agent-kit/harness';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { setup } from '../../src/cli/commands/setup.js';
import { uninstall } from '../../src/cli/commands/uninstall.js';
import { PREVIOUS_RELEASE_MARKERS } from '../../src/cli/setup-legacy.js';
import { createPresenceBundle, PRESENCE_AGENTS } from '../../src/harness/bundle.js';
import { createHarnessFixture, HARNESS_NOW, renderedRegistrations, type HarnessFixture } from '../harness-support.js';
import { installPreviousRelease, PREVIOUS_RELEASE_ARTIFACT_PATHS } from '../fixtures/previous-release.js';

const boundary = vi.hoisted(() => ({
  forbidden: vi.fn<() => never>(() => {
    throw new Error('Unexpected external operation');
  }),
  info: vi.fn<(message: string) => void>(),
  finish: vi.fn<(message: string) => void>()
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: boundary.forbidden,
  spawnSync: boundary.forbidden,
  execFile: boundary.forbidden,
  execFileSync: boundary.forbidden,
  exec: boundary.forbidden,
  execSync: boundary.forbidden
}));
vi.mock('../../src/setup.js', () => ({
  LINUX_WATCHER_SKIP_MESSAGE: 'watcher skipped in acceptance',
  platformUninstallScriptNames: () => [],
  runSetupScripts: async () => [],
  runUninstallScripts: async () => []
}));
vi.mock('../../src/migration.js', () => ({
  cleanupMigratedLegacyHome: async () => ({ from: '', to: '', removed: [] }),
  hasLegacyHomeToMigrate: async () => false,
  migrateLegacyHome: boundary.forbidden
}));
vi.mock('../../src/secret.js', () => ({ readCredential: async () => undefined, deleteCredential: boundary.forbidden }));
vi.mock('../../src/cli/credential.js', () => ({ hasCredential: async () => false }));
vi.mock('../../src/cli/commands/login.js', () => ({ login: boundary.forbidden }));
vi.mock('../../src/cli/magic-builder-setup.js', () => ({
  MAGIC_TOKEN_HELP: '',
  publishMagicBuilderFaas: boundary.forbidden
}));
vi.mock('../../src/cli/commands/url.js', () => ({ resolveSignatureUrl: boundary.forbidden }));
vi.mock('../../src/platform.js', () => ({ isMacOS: () => false }));
vi.mock('../../src/cli/ui.js', () => ({
  startIntro: () => undefined,
  createSpinner: () => ({ start: () => undefined, stop: () => undefined, error: () => undefined }),
  finishOutro: boundary.finish,
  isInteractiveTerminal: () => false,
  promptConfirm: boundary.forbidden,
  promptText: boundary.forbidden,
  promptSelect: boundary.forbidden,
  showInfo: boundary.info,
  showNote: () => undefined
}));

const fixtures: HarnessFixture[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function snapshot(home: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        result[relative(home, full)] = (await readFile(full)).toString('base64');
      }
    }
  }
  await walk(home);
  return result;
}

const scripts = ['codex-hook', 'claude-hook', 'gemini-hook', 'opencode-plugin', 'pi-extension'] as const;
async function oldScripts(fixture: HarnessFixture, action: 'install' | 'uninstall', mode: 'npx' | 'absolute') {
  const packageRoot = process.env.PRESENCE_UPGRADE_PACKAGE;
  if (!packageRoot) {
    throw new Error('Run scripts/verify-previous-release-upgrade.mjs');
  }
  // Only these filesystem-only release scripts may escape the blocked process boundary.
  const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const env = {
    HOME: fixture.home,
    PATH: '',
    CLAUDE_CONFIG_DIR: join(fixture.home, '.claude'),
    CODEX_HOME: join(fixture.home, '.codex'),
    GEMINI_CLI_HOME: join(fixture.home, '.gemini'),
    GROK_HOME: join(fixture.home, '.grok'),
    XDG_CONFIG_HOME: join(fixture.home, '.config'),
    XDG_DATA_HOME: join(fixture.home, '.local/share'),
    PI_CODING_AGENT_DIR: join(fixture.home, '.pi/agent'),
    AGENT_PRESENCE_HOOK_COMMAND: mode,
    AGENT_PRESENCE_CLI_PATH: '/work/checkout/dist/src/cli.js'
  };
  for (const name of scripts) {
    execFileSync(process.execPath, [join(packageRoot, `dist/scripts/${action}-${name}.js`)], {
      env,
      timeout: 10_000,
      stdio: 'pipe'
    });
  }
  console.log(`0.9.0 ${mode}: ${action} scripts 5/5 exit 0`);
}

it.each(['npx', 'absolute'] as const)('upgrades the real 0.9.0 %s release under an isolated home', async (mode) => {
  const fixture = await createHarnessFixture();
  const comparison = await createHarnessFixture();
  fixtures.push(fixture, comparison);
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('AGENT_PRESENCE_HOME', fixture.presenceHome);
  vi.stubEnv('AGENT_PRESENCE_HOOK_COMMAND', mode);
  vi.stubEnv('AGENT_PRESENCE_CLI_PATH', '/work/checkout/dist/src/cli.js');
  vi.spyOn(Date, 'now').mockReturnValue(HARNESS_NOW);
  process.exitCode = undefined;
  vi.clearAllMocks();
  await oldScripts(fixture, 'install', mode);
  await installPreviousRelease({ homeDir: comparison.home, commandMode: mode });
  for (const path of Object.values(PREVIOUS_RELEASE_ARTIFACT_PATHS)) {
    const real = (await readFile(join(fixture.home, path), 'utf8')).replaceAll(process.execPath, '/usr/bin/node');
    expect(real).toBe(await readFile(join(comparison.home, path), 'utf8'));
  }
  console.log(
    `0.9.0 ${mode}: fixture comparison 7/7 byte-identical${mode === 'absolute' ? ' after normalizing node executable to /usr/bin/node' : ''}`
  );
  const foreign = {
    '.pi/agent/extensions/team-audit.ts':
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nexport default function(pi: ExtensionAPI) { pi.on("before_agent_start", async () => {}); }\n',
    '.pi/agent/extensions/exists-check.ts':
      'import { existsSync } from "node:fs";\nexport const present = existsSync(new URL("./agent-presence.ts", import.meta.url));\n',
    '.config/opencode/plugins/team-audit.js':
      'function mapEvent(event) { return event; }\nexport default async () => ({ event: mapEvent });\n',
    '.config/opencode/plugins/foreign-bridge.js':
      'import { execSync } from "node:child_process";\nexport default async () => ({ event: () => execSync("/work/team-audit/dist/src/cli.js hook --event Stop") });\n'
  };
  for (const [path, content] of Object.entries(foreign)) {
    await put(join(fixture.home, path), content);
  }
  const before = await snapshot(fixture.home);
  await setup(['--hooks-only', '--yes'], {}, fixture.layer);
  expect(process.exitCode).toBe(1);
  const refusal = boundary.info.mock.calls.map(([message]) => message).join('\n');
  expect(refusal).toContain('setup refused: previous-release entries remain');
  expect(refusal).toContain('npx --yes @rivus/agent-presence@0.9.0 uninstall');
  for (const key of mode === 'npx'
    ? (['claudeSettings', 'codexHooks', 'geminiSettings', 'opencodeConfig', 'opencodePlugin', 'piExtension'] as const)
    : (['opencodeConfig', 'opencodePlugin', 'piExtension'] as const)) {
    expect(refusal).toContain(PREVIOUS_RELEASE_ARTIFACT_PATHS[key]);
  }
  expect(await snapshot(fixture.home)).toEqual(before);
  expect(fixture.cliCalls).toEqual([]);
  console.log(`0.9.0 ${mode}: setup refused exit 1; every target and queue byte-identical; no agent CLI call`);
  await oldScripts(fixture, 'uninstall', mode);
  for (const [path, content] of Object.entries(foreign)) {
    expect(await readFile(join(fixture.home, path), 'utf8')).toBe(content);
  }
  process.exitCode = undefined;
  await setup(['--hooks-only', '--yes'], {}, fixture.layer);
  expect(process.exitCode).toBeUndefined();
  expect(boundary.finish).toHaveBeenLastCalledWith('setup: ok');
  const bundle = createPresenceBundle();
  const verified = await fixture.run(verify('agent-presence', { agents: PRESENCE_AGENTS, bundle }));
  expect(verified.artifacts).toHaveLength(8);
  expect(verified.artifacts.every(({ status }) => status === 'in-sync')).toBe(true);
  const markers = bundle.artifacts.flatMap((artifact) =>
    artifact.type === 'hooks' ? PRESENCE_AGENTS.map((agent) => artifact.command.replaceAll('{agent}', agent)) : []
  );
  expect(
    await fixture.run(
      findLegacy('agent-presence', { agents: PRESENCE_AGENTS, legacyMarkers: PREVIOUS_RELEASE_MARKERS })
    )
  ).toEqual([]);
  const checks = await fixture.run(
    doctor({ owner: 'agent-presence', agents: PRESENCE_AGENTS, markers: [...markers, ...PREVIOUS_RELEASE_MARKERS] })
  );
  expect(checks.every(({ status }) => status === 'ok')).toBe(true);
  const plan = await fixture.run(planInstall(bundle, { agents: PRESENCE_AGENTS }));
  try {
    for (const agent of PRESENCE_AGENTS) {
      const registrations = renderedRegistrations(plan, agent);
      expect(registrations.length).toBeGreaterThan(0);
      expect(new Set(registrations.map(({ event }) => event)).size).toBe(registrations.length);
      console.log(`0.9.0 ${mode}: ${agent} ${registrations.length} unique event registrations`);
    }
  } finally {
    await fixture.run(discardPlan(plan));
  }
  console.log(
    `0.9.0 ${mode}: setup exit 0; verify 8/8 in-sync; doctor ${checks.length}/${checks.length} ok; no legacy entries`
  );
  for (const [path, content] of Object.entries(foreign)) {
    expect(await readFile(join(fixture.home, path), 'utf8')).toBe(content);
  }
  const plantedPath = join(fixture.home, '.claude/settings.json');
  const planted =
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"npx --yes @rivus/agent-presence@0.9.0 hook --event SessionStart"}]}]}}\n';
  await writeFile(plantedPath, planted);
  await uninstall([], {}, fixture.layer);
  expect(process.exitCode).toBeUndefined();
  expect(boundary.finish).toHaveBeenLastCalledWith('uninstall: ok');
  expect(await readFile(plantedPath, 'utf8')).toBe(planted);
  for (const [path, content] of Object.entries(foreign)) {
    expect(await readFile(join(fixture.home, path), 'utf8')).toBe(content);
  }
  expect(boundary.forbidden).not.toHaveBeenCalled();
  expect(fixture.processCalls).toEqual([]);
  console.log(
    `0.9.0 ${mode}: current uninstall exit 0; planted legacy hook and ${Object.keys(foreign).length} foreign files byte-identical; no external boundary called`
  );
});
