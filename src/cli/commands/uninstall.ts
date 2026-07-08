import { rm } from 'node:fs/promises';
import { getConfigPath, getStatePath, loadConfig, saveConfig } from '../../config.js';
import { removePluginsDir } from '../../plugin-install.js';
import { deleteCredential } from '../../secret.js';
import { runUninstallScripts } from '../../setup.js';
import { hasFlag } from '../args.js';
import { createSpinner, finishOutro, showInfo, startIntro } from '../ui.js';

export async function uninstall(args: string[] = []): Promise<void> {
  const clearCredentials = hasFlag(args, '--credentials') || hasFlag(args, '--all');
  const clearState = hasFlag(args, '--all');

  startIntro('Agent Presence uninstall');

  const spinner = createSpinner();
  spinner.start('Removing agent hooks and power watcher');
  const results = await runUninstallScripts();
  spinner.stop('Uninstallers completed');

  for (const result of results) {
    showInfo(`uninstall removed: ${result.scriptName}`);
  }

  if (clearCredentials) {
    await deleteCredential();
    const config = await loadConfig();
    delete config.slot_id;
    delete config.slotId;
    await saveConfig(config, getConfigPath());
    showInfo('credentials cleared');
  }

  if (clearState) {
    await rm(getStatePath(), { force: true });
    showInfo('local state cleared');
  }

  if (hasFlag(args, '--all')) {
    await removePluginsDir();
    showInfo('installed source plugins removed');
  }

  finishOutro('uninstall: ok');
}
