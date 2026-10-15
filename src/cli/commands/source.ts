import { isAbsolute } from 'node:path';
import { removePluginSource, saveConfig, type AppConfig } from '../../config.js';
import { hasPluginSource, loadValidatedConfig, rawConfigMap } from '../../config-schema.js';
import { installPluginPackage, packageNameFromSpec, uninstallPluginPackage } from '../../plugin-install.js';
import { describeSources, loadSourcePluginForValidation } from '../../sources.js';
import { hasFlag, optionValue } from '../args.js';
import { errorMessage } from '../errors.js';
import { promptConfirm, showInfo, showNote, showSuccess, showWarning } from '../ui.js';

async function addSource(args: string[]): Promise<void> {
  const spec = args.find((arg) => !arg.startsWith('--'));
  if (!spec) {
    showWarning(
      'usage: agent-presence source add <npm-package|@scope/pkg@version> [--id <id>] [--registry <url>] [--yes]'
    );
    process.exitCode = 1;
    return;
  }

  const registry = optionValue(args, '--registry') ?? process.env.AGENT_PRESENCE_REGISTRY;
  const explicitId = optionValue(args, '--id');
  const assumeYes = hasFlag(args, '--yes');

  // A source plugin runs in-process with the CLI's trust, which includes reading
  // the slot credential. Make that explicit before downloading and running code.
  showNote(
    'A source plugin runs in-process with agent-presence and can read your slot credential.\n' +
      `Only add packages you trust. Installing: ${spec}${registry ? ` (registry: ${registry})` : ''}`,
    'Trust'
  );
  const proceed = assumeYes || (await promptConfirm(`Install and register "${spec}" as a presence source?`, false));
  if (!proceed) {
    showWarning('aborted: pass --yes to install without a prompt, or run in a terminal to confirm.');
    process.exitCode = 1;
    return;
  }

  let installed;
  try {
    installed = await installPluginPackage(spec, { registry });
  } catch (error) {
    showWarning(`install failed: ${errorMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  // Validate the package actually exports a SourcePlugin and learn its id.
  const validation = await loadSourcePluginForValidation(installed.packageName);
  if (!validation.ok) {
    showWarning(
      `installed ${installed.packageName}@${installed.version}, but it is not a valid source plugin: ${validation.reason}. ` +
        'Removing it again.'
    );
    await uninstallPluginPackage(installed.packageName, {}).catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  const id = explicitId ?? validation.id;
  if (explicitId && explicitId !== validation.id) {
    // A source only resolves when the config key matches the plugin's own id
    // (see loadHandlerSource), so a mismatched --id would install cleanly yet
    // never count anything. Reject up front rather than leave a dead entry.
    showWarning(
      `--id "${explicitId}" does not match the package's declared source id "${validation.id}"; ` +
        `re-run without --id, or pass --id ${validation.id}. Removing the installed package.`
    );
    await uninstallPluginPackage(installed.packageName, {}).catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  // The added entry is this command's own; the sources map's other entries and every other key at every level stay
  // as the file holds them.
  const { raw } = await loadValidatedConfig();
  const sources = { ...rawConfigMap(raw.plugins?.sources), [id]: { handler: installed.packageName } };
  const plugins = { ...rawConfigMap(raw.plugins), sources } as AppConfig['plugins'];
  await saveConfig({ ...raw, plugins });

  showSuccess(`added source "${id}" -> ${installed.packageName}@${installed.version}`);
  showInfo('It will be counted on the next hook. Run `agent-presence source list` to confirm.');
}

async function listSources(): Promise<void> {
  const { config } = await loadValidatedConfig();
  console.log(JSON.stringify(describeSources(config), null, 2));
}

async function removeSource(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) {
    showWarning('usage: agent-presence source remove <id> [--keep-package]');
    process.exitCode = 1;
    return;
  }
  const keepPackage = hasFlag(args, '--keep-package');

  // Presence is judged on the file's `plugins.sources` keys, so an entry the loader dropped is still removable;
  // the removal itself applies to the file's content as read, so other entries and unknown keys stay.
  const { config, raw } = await loadValidatedConfig();
  if (!hasPluginSource(raw, id)) {
    showWarning(
      `no configured source "${id}" (built-in defaults cannot be removed; disable with { "enabled": false }).`
    );
    process.exitCode = 1;
    return;
  }

  await saveConfig(removePluginSource(raw, id));

  // If the entry pointed at an installed package (a bare specifier, not an
  // absolute path or builtin:), uninstall it too unless asked to keep it. A
  // broken entry has no validated form, so there is no handler to uninstall.
  const handler = config.plugins?.sources?.[id]?.handler;
  if (!keepPackage && handler && !handler.startsWith('builtin:') && !isAbsolute(handler)) {
    await uninstallPluginPackage(packageNameFromSpec(handler), {}).catch((error) => {
      showWarning(`removed config entry, but package uninstall failed: ${errorMessage(error)}`);
    });
  }

  showSuccess(`removed source "${id}"`);
}

function printSourceHelp(): void {
  console.log(`agent-presence source

Usage:
  agent-presence source list
  agent-presence source add <npm-package> [--id <id>] [--registry <url>] [--yes]
  agent-presence source remove <id> [--keep-package]

Notes:
  - A source plugin runs in-process and can read your slot credential; only add trusted packages.
  - Built-in sources (codex/claude/gemini/opencode/pi) are managed by config, not this command;
    override or disable them via plugins.sources in config.json.
`);
}

export async function source(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === 'add') {
    await addSource(args.slice(1));
    return;
  }
  if (subcommand === 'list' || subcommand === undefined) {
    await listSources();
    return;
  }
  if (subcommand === 'remove') {
    await removeSource(args.slice(1));
    return;
  }
  printSourceHelp();
  process.exitCode = 1;
}
