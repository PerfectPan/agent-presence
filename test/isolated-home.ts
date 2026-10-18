import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Name prefix of the temporary root that holds a test file's HOME and XDG base directories. */
export const TEST_HOME_PREFIX = 'agent-presence-test-home-';

// HOME also roots the presence home (`~/.agent-presence`) and the kit's XDG fallbacks.
const ISOLATED_DIRECTORIES = {
  HOME: 'home',
  XDG_CONFIG_HOME: 'xdg/config',
  XDG_DATA_HOME: 'xdg/data',
  XDG_STATE_HOME: 'xdg/state'
} as const;

// Variables that locate a file, an endpoint or a credential, or switch a mode, in this package or in the kit code it
// hands the process environment to (hook dialects, agent detection, usage scans). Every variable with one of these
// prefixes is removed.
const CLEARED_PREFIXES = [
  // The presence home, its config, state, log and usage files, the provider, its endpoints and credentials, the
  // render templates and the mode switches.
  'AGENT_PRESENCE_',
  'AGENT_SIGNATURE_',
  // Agent homes, settings and plugin files (dsh's plugin and patch files too), and the session, event and project
  // fallbacks hook payloads are read with.
  'CLAUDE_',
  'CODEX_',
  'CURSOR_',
  'DSH_',
  'GEMINI_',
  'GROK_',
  'OPENCODE_',
  'PI_',
  // Provider endpoints and credentials, and the agent credentials the kit's agent detection reports.
  'ANTHROPIC_',
  'FEISHU_',
  'MAGIC_',
  // Terminal panes the kit's hook dialects attach to an event.
  'CMUX_',
  'HERDR_',
  'SUPERSET_'
];
const CLEARED_NAMES = new Set([
  // The project hooks fall back to when a payload carries no working directory.
  'PWD',
  // The kit's last-resort terminal pane.
  'TMUX_PANE',
  // Grok's credential, which the kit's agent detection reports.
  'XAI_API_KEY'
]);

// What the tests take from the caller on purpose. Keep it short: a variable that names a file, an endpoint or a
// credential belongs in the cleared lists above.
const KEPT_PREFIXES = [
  // Locale and Node runtime options, which the runner and the child processes tests start inherit.
  'LC_',
  'NODE_'
];
const KEPT_NAMES = new Set([
  // Finds node, git and sh for the child processes tests start.
  'PATH',
  // Where the per-file root and each test's own temporary directories go.
  'TMPDIR',
  'LANG',
  // Turns the CLI's prompts off; tests that cover prompting mock `isInteractiveTerminal` instead.
  'CI',
  // The legacy keychain account name; tests derive the expected value from it and use temporary keychain files.
  'USER',
  // Opt-in test knobs: race repetitions and the Linux keyring integration case.
  'PRESENCE_RACE_RUNS',
  'PRESENCE_SECRET_INTEGRATION'
]);

/**
 * How the per-file setup treats an environment variable: `isolated` points it into the temporary root, `cleared`
 * removes it, `kept` leaves the caller's value on purpose, and `undefined` means the setup does not cover it.
 */
export function envTreatment(name: string): 'isolated' | 'cleared' | 'kept' | undefined {
  if (Object.hasOwn(ISOLATED_DIRECTORIES, name)) {
    return 'isolated';
  }
  if (CLEARED_NAMES.has(name) || CLEARED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return 'cleared';
  }
  if (KEPT_NAMES.has(name) || KEPT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return 'kept';
  }
  return undefined;
}

/**
 * Point this process at a fresh temporary HOME and XDG base directories, and remove every variable `envTreatment`
 * clears, so a test can only write under the temporary root and reaches no file, endpoint or credential the caller's
 * environment names. Code reads these at call time (`os.homedir()` reads HOME on POSIX), so this must run before a
 * test file creates anything that snapshots them, such as the kit platform. Returns the function that restores the
 * environment and removes the root.
 */
export function isolateTestHome(): () => void {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), TEST_HOME_PREFIX));
  for (const name of Object.keys(process.env)) {
    if (envTreatment(name) === 'cleared') {
      Reflect.deleteProperty(process.env, name);
    }
  }
  for (const [name, directory] of Object.entries(ISOLATED_DIRECTORIES)) {
    const path = join(root, directory);
    mkdirSync(path, { recursive: true });
    process.env[name] = path;
  }
  return () => {
    for (const name of Object.keys(process.env)) {
      if (!Object.hasOwn(saved, name)) {
        Reflect.deleteProperty(process.env, name);
      }
    }
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  };
}
