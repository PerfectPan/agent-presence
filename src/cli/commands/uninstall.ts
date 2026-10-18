import { rm } from 'node:fs/promises';
import { uninstall as uninstallHarness, type HarnessServices } from '@rivus/agent-kit/harness';
import { Effect, Exit, type Layer } from 'effect';
import { getConfigPath, getStatePath, saveConfig } from '../../config.js';
import { loadValidatedConfig } from '../../config-schema.js';
import { PRESENCE_AGENTS } from '../../harness/bundle.js';
import { removePresenceShim } from '../../harness/shim.js';
import { removePresenceRuntime } from '../../harness/runtime.js';
import { queuePaths, writeTombstone } from '../../queue/files.js';
import { deleteStopRequests } from '../../queue/stop-request.js';
import { takeOver, type TakeoverOptions } from '../../queue/takeover.js';
import { removePluginsDir } from '../../plugin-install.js';
import { deleteCredential } from '../../secret.js';
import { platformUninstallScriptNames, runUninstallScripts } from '../../setup.js';
import { hasFlag } from '../args.js';
import { runHarness } from '../harness.js';
import { createSpinner, finishOutro, showInfo, startIntro } from '../ui.js';

export async function uninstall(
  args: string[] = [],
  takeover: TakeoverOptions = {},
  layer?: Layer.Layer<HarnessServices>
): Promise<void> {
  const clearCredentials = hasFlag(args, '--credentials') || hasFlag(args, '--all');
  const clearState = hasFlag(args, '--all');

  startIntro('Agent Presence uninstall');

  const spinner = createSpinner();
  spinner.start('Removing agent hooks');
  const report = await runHarness(
    uninstallHarness('agent-presence', { agents: PRESENCE_AGENTS }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) {
            spinner.stop('Agent hook removal completed');
          } else {
            spinner.error('Agent hook removal failed; continuing independent removals');
          }
        })
      )
    ),
    layer
  );
  let failed = report === undefined;
  if (report) {
    for (const step of report.steps) {
      if (step.removal === 'keep' || step.removal === 'release') {
        continue;
      }
      const path = `${step.locator.path}${step.locator.pointer ? `#${step.locator.pointer}` : ''}`;
      showInfo(`uninstall artifact: ${step.action}${step.removal ? ` (${step.removal})` : ''}: ${path}`);
    }
    for (const step of report.plan.steps) {
      if (step.removal !== 'keep' && step.removal !== 'release' && step.note === undefined) {
        continue;
      }
      const locator = step.locator;
      const reason =
        step.removal === 'release'
          ? 'still used by other owners or agents'
          : (step.note ?? step.drift ?? 'user-modified');
      const path = `${locator.path}${locator.pointer ? `#${locator.pointer}` : ''}`;
      showInfo(`uninstall kept: ${path} (${reason})`);
    }
  }

  async function remove(label: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      failed = true;
      process.exitCode = 1;
      console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await remove('shim removal failed', () => removePresenceShim());
  for (const scriptName of platformUninstallScriptNames()) {
    await remove(`uninstall failed: ${scriptName}`, async () => {
      const results = await runUninstallScripts({ scriptNames: [scriptName] });
      for (const result of results) {
        showInfo(`uninstall removed: ${result.scriptName}`);
      }
    });
  }

  if (clearCredentials) {
    await remove('credential removal failed', async () => {
      await deleteCredential();
      const { raw } = await loadValidatedConfig();
      delete raw.slot_id;
      delete raw.slotId;
      await saveConfig(raw, getConfigPath());
      showInfo('credentials cleared');
    });
  }

  if (clearState) {
    await remove('local state removal failed', async () => {
      const statePath = getStatePath();
      // The tombstone goes down first: producers record nothing from here on, and the takeover below
      // leaves without starting a worker.
      await writeTombstone(statePath);
      await takeOver(
        statePath,
        async () => {
          await rm(queuePaths(statePath).queueDir, { recursive: true, force: true });
          await deleteStopRequests(statePath);
          // `<state>.worker.v` goes with the leaving order's release, so it is not deleted here.
          await rm(statePath, { force: true });
        },
        takeover
      );
      showInfo('local state cleared');
    });
  }

  if (hasFlag(args, '--all')) {
    await remove('source plugin removal failed', async () => {
      await removePluginsDir();
      showInfo('installed source plugins removed');
    });
  }

  // Uninstall may itself be running from this runtime, including its removal scripts.
  await remove('runtime removal failed', () => removePresenceRuntime());
  finishOutro(failed ? 'uninstall: incomplete' : 'uninstall: ok');
}
