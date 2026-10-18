import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Name prefix of the temporary root that holds a test file's HOME and XDG base directories. */
export const TEST_HOME_PREFIX = 'agent-presence-test-home-';

// Agent homes that hooks, installers and the usage scan read before falling back to HOME.
const AGENT_HOME_VARIABLES = new Set([
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'GROK_HOME',
  'PI_CODING_AGENT_DIR',
  'DSH_HOME'
]);

// The presence home, its log, state and config files, and every other setting the CLI reads from the environment.
const PRESENCE_VARIABLE = /^AGENT_(?:PRESENCE|SIGNATURE)_/;

// HOME also roots the presence home (`~/.agent-presence`) and the kit's XDG fallbacks.
const ISOLATED_DIRECTORIES = {
  HOME: 'home',
  XDG_CONFIG_HOME: 'xdg/config',
  XDG_DATA_HOME: 'xdg/data',
  XDG_STATE_HOME: 'xdg/state'
} as const;

/**
 * Point this process at a fresh temporary HOME and XDG base directories, and remove the variables that would locate the
 * presence home or an agent home somewhere else, so a test can only write under the temporary root. Code reads these
 * paths at call time (`os.homedir()` reads HOME on POSIX), so this must run before a test file creates anything that
 * snapshots them, such as the kit platform. Returns the function that restores the environment and removes the root.
 */
export function isolateTestHome(): () => void {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), TEST_HOME_PREFIX));
  for (const name of Object.keys(process.env)) {
    if (PRESENCE_VARIABLE.test(name) || AGENT_HOME_VARIABLES.has(name)) {
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
