import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AGENT_HOME_VARIABLES, createHarnessFixture, type HarnessFixture } from './harness-support.js';

const dependencies = vi.hoisted(() => ({
  login: vi.fn<typeof import('../src/cli/commands/login.js').login>(),
  hasCredential: vi.fn<typeof import('../src/cli/credential.js').hasCredential>(),
  loadConfig: vi.fn<typeof import('../src/config-schema.js').loadValidatedConfig>(),
  isDisabled: vi.fn<typeof import('../src/queue/files.js').isDisabled>(),
  takeOver: vi.fn<typeof import('../src/queue/takeover.js').takeOver>(),
  runHarness: vi.fn<typeof import('../src/cli/harness.js').runHarness>(),
  planInstall: vi.fn<typeof import('../src/cli/setup-plan.js').planSetupInstall>(),
  writeShim: vi.fn<typeof import('../src/harness/shim.js').writePresenceShim>(),
  runScripts: vi.fn<typeof import('../src/setup.js').runSetupScripts>(),
  installDsh: vi.fn<typeof import('../src/installers.js').installDshPlugin>(),
  readCredential: vi.fn<typeof import('../src/secret.js').readCredential>(),
  publish: vi.fn<typeof import('../src/cli/magic-builder-setup.js').publishMagicBuilderFaas>()
}));

vi.mock('../src/cli/commands/login.js', () => ({ login: dependencies.login }));
vi.mock('../src/cli/credential.js', () => ({ hasCredential: dependencies.hasCredential }));
vi.mock('../src/config-schema.js', () => ({ loadValidatedConfig: dependencies.loadConfig }));
vi.mock('../src/queue/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queue/files.js')>()),
  isDisabled: dependencies.isDisabled
}));
vi.mock('../src/queue/takeover.js', () => ({ takeOver: dependencies.takeOver }));
vi.mock('../src/cli/harness.js', () => ({ runHarness: dependencies.runHarness }));
vi.mock('../src/cli/setup-plan.js', () => ({ planSetupInstall: dependencies.planInstall }));
vi.mock('../src/harness/shim.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/harness/shim.js')>()),
  writePresenceShim: dependencies.writeShim
}));
vi.mock('../src/cli/ui.js', () => ({
  startIntro: vi.fn<typeof import('../src/cli/ui.js').startIntro>(),
  finishOutro: vi.fn<typeof import('../src/cli/ui.js').finishOutro>(),
  isInteractiveTerminal: vi.fn<typeof import('../src/cli/ui.js').isInteractiveTerminal>().mockReturnValue(false),
  promptConfirm: vi.fn<typeof import('../src/cli/ui.js').promptConfirm>(),
  promptText: vi.fn<typeof import('../src/cli/ui.js').promptText>(),
  showInfo: vi.fn<typeof import('../src/cli/ui.js').showInfo>(),
  showNote: vi.fn<typeof import('../src/cli/ui.js').showNote>(),
  createSpinner: () => ({
    start: vi.fn<(message?: string) => void>(),
    stop: vi.fn<(message?: string) => void>(),
    error: vi.fn<(message?: string) => void>()
  })
}));
vi.mock('../src/setup.js', () => ({
  LINUX_WATCHER_SKIP_MESSAGE: 'linux watcher skipped',
  runSetupScripts: dependencies.runScripts
}));
vi.mock('../src/installers.js', () => ({
  installDshPlugin: dependencies.installDsh,
  resolveDshPluginPaths: vi.fn<typeof import('../src/installers.js').resolveDshPluginPaths>()
}));
vi.mock('../src/secret.js', () => ({ readCredential: dependencies.readCredential }));
vi.mock('../src/cli/magic-builder-setup.js', () => ({
  MAGIC_TOKEN_HELP: 'fixture token help',
  publishMagicBuilderFaas: dependencies.publish
}));
vi.mock('../src/cli/commands/url.js', () => ({
  resolveSignatureUrl: vi.fn<typeof import('../src/cli/commands/url.js').resolveSignatureUrl>()
}));

let fixture: HarnessFixture;
let previousArgv: string[];
let previousExitCode: typeof process.exitCode;
let error: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let timeline: string[];

beforeEach(async () => {
  // The CLI starts on import; each case must run its own top-level catch.
  vi.resetModules();
  vi.clearAllMocks();
  fixture = await createHarnessFixture();
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('AGENT_PRESENCE_LOG_FILE', join(fixture.home, 'agent-presence.log'));
  for (const key of [
    ...AGENT_HOME_VARIABLES,
    'AGENT_PRESENCE_HOME',
    'AGENT_SIGNATURE_HOME',
    'AGENT_PRESENCE_CONFIG_FILE',
    'AGENT_SIGNATURE_CONFIG_FILE',
    'AGENT_PRESENCE_STATE_FILE',
    'AGENT_SIGNATURE_STATE_FILE',
    'AGENT_SIGNATURE_LOG_FILE',
    'AGENT_PRESENCE_HOOK_COMMAND',
    'AGENT_PRESENCE_CLI_PATH',
    'AGENT_PRESENCE_PROVIDER',
    'AGENT_SIGNATURE_PROVIDER',
    'DSH_HOME'
  ]) {
    vi.stubEnv(key, undefined);
  }
  previousArgv = process.argv;
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  timeline = [];
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { runHarness } = await vi.importActual<typeof import('../src/cli/harness.js')>('../src/cli/harness.js');
  dependencies.runHarness.mockImplementation(async (program) => {
    timeline.push('harness:start');
    const result = await runHarness(program, fixture.layer);
    timeline.push('harness:end');
    return result;
  });
  dependencies.isDisabled.mockImplementation(async () => {
    timeline.push('queue');
    return false;
  });
  dependencies.loadConfig.mockImplementation(async () => {
    timeline.push('config');
    return { config: {}, raw: {}, issues: [] };
  });
  dependencies.hasCredential.mockResolvedValue(false);
  dependencies.login.mockImplementation(async () => {
    timeline.push('login');
    throw new Error('login QR code expired');
  });
});

afterEach(async () => {
  process.argv = previousArgv;
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.dispose();
});

describe('setup failures at the CLI entry', () => {
  it.each([
    { args: ['--hook-command', 'invalid'], source: '--hook-command' },
    { args: ['--hook-command'], source: '--hook-command' },
    { args: [], source: 'AGENT_PRESENCE_HOOK_COMMAND' }
  ])('prints one hook-command error before setup starts (%j)', async ({ args, source }) => {
    process.argv = [...previousArgv.slice(0, 2), 'setup', ...args];
    vi.stubEnv('AGENT_PRESENCE_HOOK_COMMAND', 'invalid');
    const reported = new Promise<void>((resolve) => {
      error.mockImplementation(() => resolve());
    });

    await import('../src/cli.js');
    await reported;

    expect(process.exitCode).toBe(1);
    expect(error.mock.calls).toEqual([[`invalid ${source}: expected package, npx, or absolute`]]);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(timeline).toEqual([]);
    expect(dependencies.planInstall).not.toHaveBeenCalled();
    expect(dependencies.login).not.toHaveBeenCalled();
  });

  it.each([false, true])('prints one message and exits 1 with --no-hooks=%s', async (noHooks) => {
    process.argv = [...previousArgv.slice(0, 2), 'setup', ...(noHooks ? ['--no-hooks'] : [])];
    const reported = new Promise<void>((resolve) => {
      error.mockImplementation(() => resolve());
    });

    await import('../src/cli.js');
    await reported;

    expect(process.exitCode).toBe(1);
    expect(error.mock.calls).toEqual([['login QR code expired']]);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(dependencies.login).toHaveBeenCalledExactlyOnceWith(['--provider', 'magic-builder']);
    expect(timeline).toEqual(['queue', 'config', 'login']);
    expect(dependencies.runHarness).not.toHaveBeenCalled();
    expect(dependencies.takeOver).not.toHaveBeenCalled();
    expect(dependencies.planInstall).not.toHaveBeenCalled();
    expect(dependencies.writeShim).not.toHaveBeenCalled();
    expect(dependencies.runScripts).not.toHaveBeenCalled();
    expect(dependencies.installDsh).not.toHaveBeenCalled();
    expect(dependencies.readCredential).not.toHaveBeenCalled();
    expect(dependencies.publish).not.toHaveBeenCalled();
    expect(fixture.processCalls).toEqual([]);
  });
});
