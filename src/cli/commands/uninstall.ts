import { runUninstallScripts } from '../../setup.js';
import { createSpinner, finishOutro, showInfo, startIntro } from '../ui.js';

export async function uninstall(): Promise<void> {
  startIntro('Agent Presence uninstall');

  const spinner = createSpinner();
  spinner.start('Removing agent hooks and power watcher');
  const results = await runUninstallScripts();
  spinner.stop('Uninstallers completed');

  for (const result of results) {
    showInfo(`uninstall removed: ${result.scriptName}`);
  }

  finishOutro('uninstall: ok');
}
