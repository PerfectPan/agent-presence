import { findLegacy, type LegacyEntry } from '@rivus/agent-kit/harness';
import { Effect } from 'effect';
import { PRESENCE_AGENTS } from '../harness/bundle.js';
import { showInfo } from './ui.js';

// Markers must occur in presence's old artifacts and never in foreign files: the kit matches plain substrings.
export const PREVIOUS_RELEASE_MARKERS = [
  'agent-presence hook',
  '@rivus/agent-presence',
  'agent-signature hook',
  'agent-signature.mjs hook',
  'AgentSignaturePlugin',
  'runAgentPresence',
  './plugins/agent-presence.js',
  './plugins/agent-signature.js',
  '@rivus/agent-presence pi extension'
] as const;

// This is the last release before ledger-backed installs; unpinned entries may need its later bridge removers.
const PREVIOUS_RELEASE_VERSION = '0.9.0';

const INSTALL_TARGET_OVERRIDES = [
  'CLAUDE_SETTINGS_FILE',
  'GEMINI_SETTINGS_FILE',
  'CODEX_HOOKS_FILE',
  'OPENCODE_CONFIG',
  'OPENCODE_AGENT_PRESENCE_PLUGIN_FILE',
  'OPENCODE_AGENT_SIGNATURE_PLUGIN_FILE',
  'PI_SETTINGS_FILE',
  'PI_AGENT_PRESENCE_EXTENSION_FILE',
  'PI_AGENT_PRESENCE_EXTENSION_DIR'
] as const;

export function warnPreviousReleaseOverrides(): void {
  for (const variable of INSTALL_TARGET_OVERRIDES) {
    if (process.env[variable] !== undefined) {
      showInfo(
        `setup: ${variable} is set; this version ignores it. Run the previous release's uninstall with ${variable} set to the same value.`
      );
    }
  }
}

function reportPreviousRelease(entries: readonly LegacyEntry[]): void {
  const protect = entries.filter((entry) => entry.treatment === 'protect');
  const replace = entries.filter((entry) => entry.treatment === 'replace');
  for (const group of [
    { entries: protect, heading: 'files kept from an earlier removal' },
    { entries: replace, heading: 'previous-release entries' }
  ]) {
    if (group.entries.length === 0) {
      continue;
    }
    showInfo(`setup refused: ${group.heading} remain:`);
    for (const entry of group.entries) {
      const location = `${entry.locator.path}${entry.locator.pointer ? `#${entry.locator.pointer}` : ''}`;
      const hook = entry.command === undefined ? '' : `; event=${entry.event ?? 'unknown'}; command=${entry.command}`;
      showInfo(`${entry.agent}: ${location}; kind=${entry.kind}; treatment=${entry.treatment}${hook}`);
    }
  }
  for (const entry of protect) {
    showInfo(
      `${entry.locator.path} is your kept file from an earlier removal. Move or remove it by hand before uninstalling replacement entries, which could delete it.`
    );
  }
  if (replace.length > 0) {
    const versions = new Set<string>();
    for (const entry of replace) {
      const pins = [
        ...(entry.command?.matchAll(
          /@rivus\/agent-presence@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=[\s'";|&]|$)/g
        ) ?? [])
      ].map((match) => match[1]!);
      for (const version of pins.length > 0 ? pins : [PREVIOUS_RELEASE_VERSION]) {
        versions.add(version);
      }
    }
    showInfo(
      "For replace entries, after moving or removing any kept files above, run the previous release's uninstall without --credentials or --all to keep credentials, configuration and state:"
    );
    for (const version of versions) {
      showInfo(`  npx --yes @rivus/agent-presence@${version} uninstall`);
    }
    showInfo('For a checkout install, instead run: node <checkout>/dist/src/cli.js uninstall');
    showInfo(
      'Move or remove any listed entry left by that uninstall by hand, including renamed copies or hand-edited entries.'
    );
  }
  showInfo('Then run agent-presence setup again. Nothing was written to agent configuration.');
  process.exitCode = 1;
}

export function checkPreviousRelease() {
  return findLegacy('agent-presence', { agents: PRESENCE_AGENTS, legacyMarkers: PREVIOUS_RELEASE_MARKERS }).pipe(
    Effect.map((entries) => {
      if (entries.length === 0) {
        return true;
      }
      reportPreviousRelease(entries);
      return false;
    })
  );
}
