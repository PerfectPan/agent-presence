import { rm } from 'node:fs/promises';
import { getConfigPath, getStatePath, loadConfig, saveConfig } from '../../config.js';
import { queuePaths, writeTombstone } from '../../queue/files.js';
import { deleteStopRequests } from '../../queue/stop-request.js';
import { takeOver, type TakeoverOptions } from '../../queue/takeover.js';
import { removePluginsDir } from '../../plugin-install.js';
import { deleteCredential } from '../../secret.js';
import { runUninstallScripts } from '../../setup.js';
import { hasFlag } from '../args.js';
import { createSpinner, finishOutro, showInfo, startIntro } from '../ui.js';

export async function uninstall(args: string[] = [], takeover: TakeoverOptions = {}): Promise<void> {
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
    const statePath = getStatePath();
    // The tombstone goes down first (Plan 0003 3.8): producers record nothing from here on, and the takeover below
    // leaves without starting a worker.
    await writeTombstone(statePath);
    await takeOver(
      statePath,
      async () => {
        await rm(queuePaths(statePath).queueDir, { recursive: true, force: true });
        await deleteStopRequests(statePath);
        // `<state>.worker.v` goes with the leaving order's release (3.6), so it is not deleted here.
        await rm(statePath, { force: true });
      },
      takeover
    );
    showInfo('local state cleared');
  }

  if (hasFlag(args, '--all')) {
    await removePluginsDir();
    showInfo('installed source plugins removed');
  }

  finishOutro('uninstall: ok');
}
