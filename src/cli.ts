#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  debounceMs,
  configSlotId,
  feishuSignatureConfig,
  getConfigPath,
  getLogPath,
  getStatePath,
  loadConfig,
  previewBaseUrl,
  previewImageKey,
  previewTargetUrl,
  providerId,
  providerBaseUrl,
  renderTemplates,
  saveConfig,
  DEFAULT_LOGIN_POLL_MS,
  ttlMs,
  type AppConfig
} from './config.js';
import { resolveClaudeHookContext } from './hooks/claude.js';
import { resolveCodexHookContext } from './hooks/codex.js';
import { resolveOpenCodeHookContext } from './hooks/opencode.js';
import { LGaryYangProvider } from './providers/l-garyyang.js';
import {
  markSlotSyncSuccess,
  prepareSlotSync,
  renderPresence,
  rollbackSlotSyncClaim,
  SlotRateLimitError,
  type RenderTemplates,
  type SlotSyncDecision,
  type SyncSlotResult
} from './render.js';
import { readCredential, writeCredential } from './secret.js';
import { runSetupScripts } from './setup.js';
import { applyAgentEvent, finishAllSessions, getActiveSessions, loadState, saveState, withStateLock, type PresenceState } from './state.js';

interface ParsedArgs {
  command?: string;
  args: string[];
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'login':
      await login(parsed.args);
      return;
    case 'setup':
      await setup(parsed.args);
      return;
    case 'url':
      await printSignatureUrl(parsed.args);
      return;
    case 'config':
      await configure(parsed.args);
      return;
    case 'status':
      await printStatus(parsed.args);
      return;
    case 'update':
      await update(parsed.args);
      return;
    case 'reset':
      await reset(parsed.args);
      return;
    case 'hook':
      await hook(parsed.args);
      return;
    default:
      printHelp();
      process.exitCode = 1;
  }
}

async function login(args: string[] = []): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const provider = new LGaryYangProvider(providerBaseUrl(config));
  const qr = await provider.createQrCode();
  const expiresAt = Date.now() + qr.expiresIn * 1000;

  console.log(`sceneId: ${qr.sceneId}`);
  console.log(`qrcode: ${qr.qrcodeUrl}`);
  console.log('scan the qrcode, then keep this command running until login succeeds');

  while (Date.now() < expiresAt) {
    const status = await provider.getLoginStatus(qr.sceneId);
    if ('token' in status) {
      await writeCredential({ token: status.token, slotId: status.slotId });
      await saveConfig({ ...config, provider: activeProvider, slot_id: status.slotId }, getConfigPath());
      console.log(`slot_id: ${status.slotId}`);
      console.log('login: ok');
      return;
    }

    console.log(`login status: ${status.status}`);
    await sleep(DEFAULT_LOGIN_POLL_MS);
  }

  throw new Error('login qrcode expired before authorization completed');
}

async function setup(args: string[]): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const skipLogin = args.includes('--skip-login') || args.includes('--hooks-only');
  const skipHooks = args.includes('--no-hooks');

  if (!skipLogin && !(await hasCredential())) {
    await login(['--provider', activeProvider]);
  }

  if (!skipHooks) {
    const results = await runSetupScripts();
    for (const result of results) {
      console.log(`setup installed: ${result.scriptName}`);
    }
  }

  if (await hasCredential()) {
    process.stdout.write('signature url: ');
    await printSignatureUrl(['--provider', activeProvider]);
  } else {
    console.log('signature url: unavailable until `agent-presence login` succeeds');
  }

  console.log('setup: ok');
}

async function hasCredential(): Promise<boolean> {
  const config = await loadConfig();
  const credential = await readCredential(configSlotId(config));
  return Boolean(credential?.token && credential.slotId);
}

async function printSignatureUrl(args: string[] = []): Promise<void> {
  const config = await loadConfig();
  providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const slotId = credential?.slotId ?? configSlotId(config);
  if (!slotId) {
    throw new Error('missing slot_id; run `agent-presence login` first');
  }

  const provider = new LGaryYangProvider(providerBaseUrl(config), credential);
  console.log(
    provider.buildSignatureUrl({
      slotId,
      imageKey: previewImageKey(config),
      targetUrl: previewTargetUrl(config),
      previewBaseUrl: previewBaseUrl(config)
    })
  );
}

async function printStatus(args: string[]): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const now = Date.now();
  const statePath = getStatePath();
  const credential = await readCredential(configSlotId(config));
  let payload: Record<string, unknown> | undefined;

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    const active = getActiveSessions(state, now, ttlMs(config));
    await saveState(state, statePath);
    payload = {
      activeCount: active.length,
      value: renderPresence(active, renderTemplates(config)),
      active,
      provider: activeProvider,
      lastValue: state.lastValue ?? '',
      lastSlotUpdateAt: state.lastSlotUpdateAt ?? 0,
      statePath,
      hasToken: Boolean(credential?.token),
      slotId: credential?.slotId ?? configSlotId(config) ?? ''
    };
  });

  if (args.includes('--remote') && credential) {
    requirePayload(payload).remote = await new LGaryYangProvider(providerBaseUrl(config), credential).getInfo();
  }

  console.log(JSON.stringify(requirePayload(payload), null, 2));
}

async function update(args: string[]): Promise<void> {
  const config = await loadConfig();
  providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = new LGaryYangProvider(providerBaseUrl(config), credential);
  const statePath = getStatePath();
  const force = args.includes('--force');
  const now = Date.now();
  const explicitValue = optionValue(args, '--value');

  if (explicitValue !== undefined) {
    const result = await syncExplicitSlotValueWithStateLock(
      statePath,
      {
        force,
        now,
        debounceMs: debounceMs(config),
        value: explicitValue.slice(0, 200)
      },
      (value) => provider.updateSlot(value)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = await syncRenderedSlotWithStateLock(
    statePath,
    {
      force,
      now,
      debounceMs: debounceMs(config),
      ttlMs: ttlMs(config),
      renderTemplates: renderTemplates(config)
    },
    (value) => provider.updateSlot(value)
  );
  console.log(JSON.stringify(result, null, 2));
}

async function reset(args: string[]): Promise<void> {
  const config = await loadConfig();
  providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = new LGaryYangProvider(providerBaseUrl(config), credential);
  const statePath = getStatePath();
  const now = Date.now();
  const force = args.includes('--force');
  const silent = args.includes('--silent');

  const result = await syncRenderedSlotWithStateLock(
    statePath,
    {
      force,
      now,
      debounceMs: debounceMs(config),
      ttlMs: ttlMs(config),
      renderTemplates: renderTemplates(config)
    },
    (value) => provider.updateSlot(value),
    (state) => {
      finishAllSessions(state, now);
    }
  );
  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function hook(args: string[]): Promise<void> {
  try {
    const source = optionValue(args, '--source') ?? 'codex';
    const silent = args.includes('--silent');
    const payload = await readStdinJson();
    const context = resolveHookContext(source, payload);
    const event = optionValue(args, '--event') ?? context.event ?? 'Heartbeat';

    if (!context.sessionId) {
      await log(`hook skipped: missing session id for source=${source} event=${event}`);
      writeHookOutput(silent);
      return;
    }

    const config = await loadConfig();
    const credential = await readCredential(configSlotId(config));
    const provider = new LGaryYangProvider(providerBaseUrl(config), credential);
    const statePath = getStatePath();

    await syncRenderedSlotWithStateLock(
      statePath,
      {
        force: false,
        now: Date.now(),
        debounceMs: debounceMs(config),
        ttlMs: ttlMs(config),
        renderTemplates: renderTemplates(config)
      },
      (value) => provider.updateSlot(value),
      (state) => {
        applyAgentEvent(state, {
          source,
          event,
          sessionId: context.sessionId!,
          project: context.project,
          now: Date.now()
        });
      }
    );
  } catch (error) {
    await log(`hook failed: ${errorMessage(error)}`);
  }

  writeHookOutput(args.includes('--silent'));
}

async function syncRenderedSlotWithStateLock(
  statePath: string,
  options: {
    force: boolean;
    now: number;
    debounceMs: number;
    ttlMs: number;
    renderTemplates?: RenderTemplates;
  },
  updateSlot: (value: string) => Promise<void>,
  mutateState?: (state: PresenceState) => void
): Promise<SyncSlotResult> {
  let decision: SlotSyncDecision | undefined;

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    mutateState?.(state);
    decision = prepareSlotSync(state, options);
    await saveState(state, statePath);
  });

  return applySlotSyncDecision(statePath, requireDecision(decision), updateSlot);
}

async function syncExplicitSlotValueWithStateLock(
  statePath: string,
  options: {
    force: boolean;
    now: number;
    debounceMs: number;
    value: string;
  },
  updateSlot: (value: string) => Promise<void>
): Promise<SyncSlotResult> {
  let decision: SlotSyncDecision | undefined;
  let result: SyncSlotResult | undefined;

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    const elapsedMs = options.now - (state.lastSlotUpdateAt ?? 0);
    if (!options.force && elapsedMs < options.debounceMs) {
      result = { status: 'skipped', reason: 'debounced', value: options.value };
      await saveState(state, statePath);
      return;
    }

    decision = {
      action: 'update',
      value: options.value,
      previousLastSlotUpdateAt: state.lastSlotUpdateAt ?? 0,
      claimedLastSlotUpdateAt: options.now
    };
    state.lastSlotUpdateAt = options.now;
    await saveState(state, statePath);
  });

  if (result) {
    return result;
  }

  return applySlotSyncDecision(statePath, requireDecision(decision), updateSlot);
}

async function applySlotSyncDecision(
  statePath: string,
  decision: SlotSyncDecision,
  updateSlot: (value: string) => Promise<void>
): Promise<SyncSlotResult> {
  if (decision.action === 'skip') {
    return decision.result;
  }

  try {
    await updateSlot(decision.value);
  } catch (error) {
    if (error instanceof SlotRateLimitError) {
      return { status: 'skipped', reason: 'rate-limited', value: decision.value };
    }
    await rollbackSlotDecision(statePath, decision);
    throw error;
  }

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    markSlotSyncSuccess(state, decision);
    await saveState(state, statePath);
  });

  return { status: 'updated', value: decision.value };
}

async function rollbackSlotDecision(statePath: string, decision: SlotSyncDecision): Promise<void> {
  if (decision.action !== 'update') {
    return;
  }
  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    rollbackSlotSyncClaim(state, decision);
    await saveState(state, statePath);
  });
}

function requireDecision(decision: SlotSyncDecision | undefined): SlotSyncDecision {
  if (!decision) {
    throw new Error('internal error: missing slot sync decision');
  }
  return decision;
}

function requirePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) {
    throw new Error('internal error: missing status payload');
  }
  return payload;
}

async function configure(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'show';
  if (subcommand === 'show') {
    await printConfig();
    return;
  }
  if (subcommand === 'render' || subcommand === 'text') {
    await configureRender(args.slice(1));
    return;
  }
  if (subcommand === 'provider') {
    await configureProvider(args.slice(1));
    return;
  }
  printConfigHelp();
  process.exitCode = 1;
}

async function printConfig(): Promise<void> {
  const config = await loadConfig();
  console.log(
    JSON.stringify(
      {
        configPath: getConfigPath(),
        provider: providerId(config),
        providerConfig: feishuSignatureConfig(config),
        slotId: configSlotId(config) ?? '',
        ttlMs: ttlMs(config),
        debounceMs: debounceMs(config),
        render: renderTemplates(config)
      },
      null,
      2
    )
  );
}

async function configureProvider(args: string[]): Promise<void> {
  const config = await loadConfig();
  const explicitProvider = args[0]?.startsWith('--') ? optionValue(args, '--provider') : (args[0] ?? optionValue(args, '--provider'));
  const targetProvider = providerId(config, explicitProvider);
  const reset = args.includes('--reset');
  const providers = { ...(config.providers ?? {}) };
  const nextConfig: AppConfig = { ...config, provider: targetProvider, providers };
  const nextProviderConfig = reset ? {} : { ...(config.providers?.[targetProvider] ?? {}) };

  setOptionalTemplate(nextProviderConfig, 'baseUrl', optionValue(args, '--base-url'));
  setOptionalTemplate(nextProviderConfig, 'previewBaseUrl', optionValue(args, '--preview-base-url'));
  setOptionalTemplate(nextProviderConfig, 'previewImageKey', optionValue(args, '--image-key'));
  setOptionalTemplate(nextProviderConfig, 'previewTargetUrl', optionValue(args, '--target-url'));

  if (Object.keys(nextProviderConfig).length > 0) {
    providers[targetProvider] = nextProviderConfig;
  } else {
    delete providers[targetProvider];
    if (Object.keys(providers).length === 0) {
      delete nextConfig.providers;
    }
  }

  await saveConfig(nextConfig, getConfigPath());
  console.log(
    JSON.stringify(
      {
        status: 'updated',
        provider: targetProvider,
        providerConfig: feishuSignatureConfig(nextConfig)
      },
      null,
      2
    )
  );
}

async function configureRender(args: string[]): Promise<void> {
  const config = await loadConfig();
  const reset = args.includes('--reset');
  const nextConfig = { ...config };
  const nextRender = reset ? {} : { ...(config.render ?? {}) };

  setOptionalTemplate(nextRender, 'zero', optionValue(args, '--zero'));
  setOptionalTemplate(nextRender, 'one', optionValue(args, '--one'));
  setOptionalTemplate(nextRender, 'many', optionValue(args, '--many'));

  if (Object.keys(nextRender).length > 0) {
    nextConfig.render = nextRender;
  } else {
    delete nextConfig.render;
  }

  await saveConfig(nextConfig, getConfigPath());
  console.log(
    JSON.stringify(
      {
        status: 'updated',
        render: renderTemplates(nextConfig),
        variables: ['{total}', '{details}']
      },
      null,
      2
    )
  );
}

function setOptionalTemplate(target: Record<string, string>, key: string, value: string | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function resolveHookContext(source: string, payload: unknown): { event?: string; sessionId?: string; project?: string } {
  if (source === 'codex') {
    return resolveCodexHookContext(payload);
  }
  if (source === 'claude') {
    return resolveClaudeHookContext(payload);
  }
  if (source === 'opencode') {
    return resolveOpenCodeHookContext(payload);
  }
  return {};
}

function writeHookOutput(silent: boolean): void {
  if (!silent) {
    process.stdout.write('{}\n');
  }
}

async function readStdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) {
    return {};
  }
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
    }
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function log(message: string): Promise<void> {
  const path = getLogPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

function parseArgs(args: string[]): ParsedArgs {
  return {
    command: args[0],
    args: args.slice(1)
  };
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  console.log(`agent-presence

Usage:
  agent-presence login [--provider feishu-signature]
  agent-presence setup [--provider feishu-signature] [--skip-login] [--no-hooks]
  agent-presence url [--provider feishu-signature]
  agent-presence config show
  agent-presence config provider feishu-signature [--base-url <url>] [--preview-base-url <url>] [--image-key <key>] [--target-url <url>] [--reset]
  agent-presence config render [--zero <template>] [--one <template>] [--many <template>] [--reset]
  agent-presence status [--provider feishu-signature] [--remote]
  agent-presence update [--provider feishu-signature] [--force] [--value <text>]
  agent-presence reset [--provider feishu-signature] [--force] [--silent]
  agent-presence hook --source codex --event <SessionStart|Heartbeat|UserPromptSubmit|PreToolUse|Stop>
  agent-presence hook --source claude --event <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd|SubagentStart|SubagentStop> --silent
  agent-presence hook --source opencode --event <SessionStart|Heartbeat|Stop> --silent
`);
}

function printConfigHelp(): void {
  console.log(`agent-presence config

Usage:
  agent-presence config show
  agent-presence config provider feishu-signature --base-url <url> --preview-base-url <url> --image-key <key> --target-url <url>
  agent-presence config provider feishu-signature --reset
  agent-presence config render --zero <template> --one <template> --many <template>
  agent-presence config render --reset

Template variables:
  {total}    active agent count
  {details}  grouped source counts, for example: codex 1 · claude 1
`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
