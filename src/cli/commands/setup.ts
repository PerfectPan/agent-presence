import { configSlotId, loadConfig, providerId } from '../../config.js';
import { cleanupMigratedLegacyHome, hasLegacyHomeToMigrate, migrateLegacyHome } from '../../migration.js';
import { isMacOS } from '../../platform.js';
import { readCredential } from '../../secret.js';
import { LINUX_WATCHER_SKIP_MESSAGE, runSetupScripts } from '../../setup.js';
import { hasFlag, optionValue } from '../args.js';
import { hasCredential } from '../credential.js';
import { MAGIC_TOKEN_HELP, publishMagicBuilderFaas } from '../magic-builder-setup.js';
import { createSpinner, finishOutro, isInteractiveTerminal, promptConfirm, promptText, showInfo, showNote, startIntro } from '../ui.js';
import { login } from './login.js';
import { resolveSignatureUrl } from './url.js';

export async function setup(args: string[]): Promise<void> {
  const skipLogin = hasFlag(args, '--skip-login') || hasFlag(args, '--hooks-only');
  const forceLogin = hasFlag(args, '--login') && !skipLogin;
  const skipHooks = hasFlag(args, '--no-hooks');
  const hookCommandMode = optionValue(args, '--hook-command');

  if (hookCommandMode) {
    process.env.AGENT_PRESENCE_HOOK_COMMAND = hookCommandMode;
  }

  startIntro('Agent Presence setup');
  await cleanupMigratedLegacyHome();
  if (await hasLegacyHomeToMigrate()) {
    const migration = await migrateLegacyHome({
      confirm: () =>
        promptConfirm('Move existing Agent Presence files from ~/.codex/agent-signature to ~/.agent-presence?')
    });
    if (migration.status === 'migrated') {
      const skipped = migration.skipped.length > 0 ? `; kept existing destination files: ${migration.skipped.join(', ')}` : '';
      const removed = migration.removed.length > 0 ? `; removed legacy files: ${migration.removed.join(', ')}` : '';
      showInfo(`migrated local files: ${migration.copied.join(', ') || 'none'}${skipped}${removed}`);
    } else if (migration.status === 'skipped') {
      showInfo('migration skipped; legacy config can still be read for this setup run');
    }
  }

  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));

  if (!skipLogin && (forceLogin || !(await hasCredential()))) {
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
    if (!isMacOS()) {
      showInfo(LINUX_WATCHER_SKIP_MESSAGE);
    }
    showNote(
      'Codex may require you to approve the updated Agent Presence hooks in Codex settings before they run.',
      'Codex hook trust'
    );
  }

  const credential = await readCredential(configSlotId(config));

  if (activeProvider === 'magic-builder') {
    if (!credential?.token || !credential.slotId) {
      showInfo('login: missing; run `agent-presence login --provider feishu-signature` first');
      showInfo('signature url: unavailable until `agent-presence login` succeeds');
    } else {
      try {
        // The token prompt (if needed) runs via acquireToken before any
        // spinner starts, so the Clack text input is not clobbered.
        let promptShown = false;
        const result = await publishMagicBuilderFaas({
          acquireToken: async () => {
            if (!isInteractiveTerminal()) {
              return undefined;
            }
            promptShown = true;
            showNote(MAGIC_TOKEN_HELP, 'Magic-Builder token');
            return promptText({
              message: 'Paste your Magic-Builder token:',
              validate: (value) => (value && value.trim().length > 0 ? undefined : 'token cannot be empty')
            });
          }
        });
        if (promptShown) {
          showInfo('magic-builder token saved to OS keyring');
        }
        showInfo(`magic-builder token source: ${result.tokenSource}${result.tokenPath ? ` (${result.tokenPath})` : ''}`);
        showInfo(`magic-builder record_id: ${result.recordId}`);
        showInfo(result.isUpdate ? 'magic-builder FaaS updated' : 'magic-builder FaaS published');
        showNote(result.url, 'Signature URL');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showInfo(`magic-builder setup failed: ${message}`);
        showInfo('signature url: unavailable until publish succeeds');
      }
    }
  } else if (credential?.token && credential.slotId) {
    showNote(await resolveSignatureUrl(['--provider', activeProvider]), 'Signature URL');
  } else {
    showInfo('login: missing; run `agent-presence login --provider feishu-signature` to enable slot updates');
    showInfo('signature url: unavailable until `agent-presence login` succeeds');
  }

  finishOutro('setup: ok');
}
