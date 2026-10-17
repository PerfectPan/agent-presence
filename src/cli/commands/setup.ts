import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyInstall, discardPlan, verify, type HarnessServices } from '@rivus/agent-kit/harness';
import { Effect, type Layer } from 'effect';

import { configSlotId, defaultCommandProviderId, getStatePath } from '../../config.js';
import { loadValidatedConfig } from '../../config-schema.js';
import { createPresenceBundle, PRESENCE_AGENTS } from '../../harness/bundle.js';
import { readPresenceShimRuntimeVersion, resolveHookCommandMode, writePresenceShim } from '../../harness/shim.js';
import {
  installPresenceRuntime,
  prunePresenceRuntimes,
  withPresenceRuntimeLock,
  type RuntimeInstallOptions
} from '../../harness/runtime.js';
import { packageVersion } from '../../package-version.js';
import { increaseEpoch, isDisabled, removeTombstone } from '../../queue/files.js';
import { deleteQueueFile, listQueue } from '../../queue/reader.js';
import { takeOver, type TakeoverOptions } from '../../queue/takeover.js';
import { hasManagedDshPlugin, installDshPlugin, resolveDshPluginPaths } from '../../installers.js';
import { cleanupMigratedLegacyHome, hasLegacyHomeToMigrate, migrateLegacyHome } from '../../migration.js';
import { isMacOS } from '../../platform.js';
import { readCredential } from '../../secret.js';
import { LINUX_WATCHER_SKIP_MESSAGE, runSetupScripts } from '../../setup.js';
import { hasFlag, optionValue } from '../args.js';
import { hasCredential } from '../credential.js';
import { runHarness } from '../harness.js';
import { checkPreviousRelease, warnPreviousReleaseOverrides } from '../setup-legacy.js';
import { planSetupInstall } from '../setup-plan.js';
import { MAGIC_TOKEN_HELP, publishMagicBuilderFaas } from '../magic-builder-setup.js';
import {
  createSpinner,
  finishOutro,
  isInteractiveTerminal,
  promptConfirm,
  promptText,
  showInfo,
  showNote,
  startIntro
} from '../ui.js';
import { login } from './login.js';
import { resolveSignatureUrl } from './url.js';

/**
 * Existing managed plugins already opted in; only a fresh installation needs
 * interactive confirmation.
 */
async function maybeInstallDshPlugin(): Promise<void> {
  const paths = resolveDshPluginPaths();
  if (!(await hasManagedDshPlugin(paths))) {
    if (!isInteractiveTerminal()) {
      return;
    }
    const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
    if (!existsSync(dshHome)) {
      return;
    }
    const install = await promptConfirm('Install the dsh plugin for presence + token usage reporting?');
    if (!install) {
      return;
    }
  }
  const result = await installDshPlugin(paths);
  showInfo(`setup installed: dsh plugin (${result.pluginPath})`);
  if (result.patchError) {
    showNote(`could not update dsh patch at ${result.patchPath}: ${result.patchError}`, 'dsh plugin');
  }
}

async function confirmInstallation(): Promise<boolean> {
  try {
    return await promptConfirm('Apply this installation plan?');
  } catch (error) {
    if (error instanceof Error && error.message === 'operation cancelled') {
      return false;
    }
    throw error;
  }
}

async function publishProvider(
  config: Awaited<ReturnType<typeof loadValidatedConfig>>['config'],
  activeProvider: string
): Promise<void> {
  const credential = await readCredential(configSlotId(config));

  if (activeProvider === 'magic-builder') {
    if (!credential?.token || !credential.slotId) {
      showInfo('login: missing; run `agent-presence login --provider feishu-signature` first');
      showInfo('signature url: unavailable until `agent-presence login` succeeds');
    } else {
      try {
        // The token prompt (if needed) runs via acquireToken before any
        // spinner starts, so the Clack text input is not clobbered.
        // The flag lives in an object because it is mutated inside the
        // acquireToken callback below.
        const promptState = { shown: false };
        const result = await publishMagicBuilderFaas({
          acquireToken: async () => {
            if (!isInteractiveTerminal()) {
              return undefined;
            }
            promptState.shown = true;
            showNote(MAGIC_TOKEN_HELP, 'Magic-Builder token');
            return promptText({
              message: 'Paste your Magic-Builder token:',
              validate: (value) => (value && value.trim().length > 0 ? undefined : 'token cannot be empty')
            });
          }
        });
        if (promptState.shown) {
          showInfo('magic-builder token saved to OS keyring');
        }
        showInfo(
          `magic-builder token source: ${result.tokenSource}${result.tokenPath ? ` (${result.tokenPath})` : ''}`
        );
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
}

export async function setup(
  args: string[],
  takeover: TakeoverOptions = {},
  layer?: Layer.Layer<HarnessServices>,
  runtimeOptions: RuntimeInstallOptions = {}
): Promise<void> {
  const skipLogin = hasFlag(args, '--skip-login') || hasFlag(args, '--hooks-only');
  const forceLogin = hasFlag(args, '--login') && !skipLogin;
  const skipHooks = hasFlag(args, '--no-hooks');
  const hookCommandMode = optionValue(args, '--hook-command');
  const mode = resolveHookCommandMode(
    hasFlag(args, '--hook-command') ? (hookCommandMode ?? '') : process.env.AGENT_PRESENCE_HOOK_COMMAND
  );

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
      const skipped =
        migration.skipped.length > 0 ? `; kept existing destination files: ${migration.skipped.join(', ')}` : '';
      const removed = migration.removed.length > 0 ? `; removed legacy files: ${migration.removed.join(', ')}` : '';
      showInfo(`migrated local files: ${migration.copied.join(', ') || 'none'}${skipped}${removed}`);
    } else if (migration.status === 'skipped') {
      showInfo('migration skipped; legacy config can still be read for this setup run');
    }
  }

  warnPreviousReleaseOverrides();

  if (!skipHooks && !(await runHarness(checkPreviousRelease(), layer))) {
    return;
  }

  // An uninstall --all or worker --stop left the tombstone (Plan 0003 3.8): drop the records it kept from applying, raise
  // the epoch so a record a producer still writes with the old epoch is deleted unapplied, and let hooks record again.
  const statePath = getStatePath();
  if (await isDisabled(statePath)) {
    await takeOver(
      statePath,
      async () => {
        // `.tmp-` files and `failed/` stay: the worker removes expired `.tmp-` files, and a late rename lands with the
        // old epoch and is deleted unapplied.
        for (const file of (await listQueue(statePath)).records) {
          await deleteQueueFile(file);
        }
        await increaseEpoch(statePath);
        await removeTombstone(statePath);
      },
      takeover
    );
  }

  const { config } = await loadValidatedConfig();
  const activeProvider = defaultCommandProviderId(config, optionValue(args, '--provider'));
  if (!skipLogin && (forceLogin || !(await hasCredential()))) {
    await login(['--provider', activeProvider]);
  }

  if (skipHooks) {
    await publishProvider(config, activeProvider);
    finishOutro('setup: ok');
    return;
  }

  const bundle = createPresenceBundle();
  let previousRuntimeVersion: string | undefined;
  let currentRuntimeVersion = packageVersion();
  const completed = await runHarness(
    Effect.gen(function* () {
      const plan = yield* planSetupInstall(bundle);
      if (!plan) {
        return false;
      }
      return yield* Effect.gen(function* () {
        const interactive = isInteractiveTerminal();
        if (!interactive && !hasFlag(args, '--yes')) {
          showInfo(
            'setup requires confirmation; run with --yes in a non-interactive terminal. Nothing was written to agent configuration.'
          );
          process.exitCode = 1;
          return false;
        }
        if (interactive && !(yield* Effect.tryPromise(confirmInstallation))) {
          showInfo('setup cancelled: nothing was written to agent configuration');
          process.exitCode = 1;
          return false;
        }
        yield* Effect.tryPromise(() =>
          withPresenceRuntimeLock(async () => {
            previousRuntimeVersion = await readPresenceShimRuntimeVersion();
            const runtime = mode === 'package' ? await installPresenceRuntime(undefined, runtimeOptions) : undefined;
            currentRuntimeVersion = runtime?.version ?? currentRuntimeVersion;
            await writePresenceShim(undefined, {
              mode,
              ...(runtime ? { cliPath: runtime.cliPath, version: runtime.version } : {})
            });
          })
        );
        const applied = yield* applyInstall(plan).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error._tag === 'PlanStale' || error._tag === 'TargetChanged') {
                showInfo('The installation plan changed; run setup again.');
              }
            })
          )
        );
        for (const step of applied.steps) {
          showInfo(
            `setup ${step.action}: ${step.locator.path}${step.locator.pointer ? `#${step.locator.pointer}` : ''}`
          );
        }
        const verified = yield* verify('agent-presence', { bundle, agents: PRESENCE_AGENTS });
        for (const artifact of verified.artifacts) {
          showInfo(
            `verify ${artifact.status}: ${artifact.locator.path}${artifact.locator.pointer ? `#${artifact.locator.pointer}` : ''}`
          );
        }
        if (
          verified.artifacts.some((artifact) => artifact.status !== 'in-sync' && artifact.status !== 'ledger-behind')
        ) {
          showInfo('setup verification failed; run doctor and setup again.');
          process.exitCode = 1;
          return false;
        }
        return true;
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => (plan.status === 'ready' ? discardPlan(plan).pipe(Effect.orDie) : Effect.void))
        )
      );
    }),
    layer
  );
  if (!completed) {
    return;
  }
  const setupSpinner = createSpinner();
  setupSpinner.start('Installing power watcher');
  const results = await runSetupScripts();
  setupSpinner.stop('Installers completed');
  for (const result of results) {
    showInfo(`setup installed: ${result.scriptName}`);
  }
  if (!isMacOS()) {
    showInfo(LINUX_WATCHER_SKIP_MESSAGE);
  }
  await maybeInstallDshPlugin();
  await publishProvider(config, activeProvider);
  await withPresenceRuntimeLock(async () => {
    await prunePresenceRuntimes(
      currentRuntimeVersion,
      previousRuntimeVersion,
      undefined,
      await readPresenceShimRuntimeVersion()
    );
  });
  finishOutro('setup: ok');
}
