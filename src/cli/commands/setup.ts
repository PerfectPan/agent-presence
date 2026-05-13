import { configSlotId, loadConfig, providerId } from '../../config.js';
import { readCredential } from '../../secret.js';
import { runSetupScripts } from '../../setup.js';
import { hasFlag, optionValue } from '../args.js';
import { hasCredential } from '../credential.js';
import { createSpinner, finishOutro, showInfo, showNote, startIntro } from '../ui.js';
import { login } from './login.js';
import { resolveSignatureUrl } from './url.js';

export async function setup(args: string[]): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const skipLogin = hasFlag(args, '--skip-login') || hasFlag(args, '--hooks-only');
  const skipHooks = hasFlag(args, '--no-hooks');

  startIntro('Agent Presence setup');
  if (!skipLogin && !(await hasCredential())) {
    await login(['--provider', activeProvider]);
  }

  if (!skipHooks) {
    const setupSpinner = createSpinner();
    setupSpinner.start('Installing agent hooks and power watcher');
    const results = await runSetupScripts();
    setupSpinner.stop('Installers completed');
    for (const result of results) {
      showInfo(`setup installed: ${result.scriptName}`);
    }
  }

  const credential = await readCredential(configSlotId(config));
  if (credential?.token && credential.slotId) {
    showNote(await resolveSignatureUrl(['--provider', activeProvider]), 'Signature URL');
  } else {
    showInfo('signature url: unavailable until `agent-presence login` succeeds');
  }

  finishOutro('setup: ok');
}
