import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readJsonFile, writeJsonAtomic } from './json-file.js';
import type { RenderTemplates } from './render.js';
import type { PricingOverrides } from './usage/index.js';

export const DEFAULT_PROVIDER_BASE_URL = 'https://l.garyyang.work';
export const DEFAULT_PREVIEW_BASE_URL = 'https://l.garyyang.work/';
export const DEFAULT_MAGIC_BUILDER_BASE_URL = 'https://magic.solutionsuite.cn';
export const DEFAULT_TTL_MS = 3 * 60 * 1000;
export const DEFAULT_DEBOUNCE_MS = 60 * 1000;
export const DEFAULT_LOGIN_POLL_MS = 3 * 1000;
export const DEFAULT_PROVIDER_ID = 'magic-builder';

export type ProviderId = 'feishu-signature' | 'magic-builder';

export interface FeishuSignatureProviderConfig {
  baseUrl?: string;
  previewBaseUrl?: string;
  previewImageKey?: string;
  previewTargetUrl?: string;
}

export interface MagicBuilderProviderConfig {
  baseUrl?: string;
  /** record_id returned by magic.solutionsuite.cn POST /api/faas. */
  faasId?: string;
  /** Human-readable function name stored alongside the record. */
  faasName?: string;
  /** Fallback title returned when the slot fetch fails. */
  fallbackTitle?: string;
}

export interface UsageConfig {
  /** Append a "today's usage" badge to the signature title. Opt-in. */
  showInSignature?: boolean;
  /** Rolling-window length (days) shown in the signature badge. Defaults to 1. */
  signatureWindowDays?: number;
  /** Pricing overrides keyed by model substring, USD per million tokens. */
  pricing?: PricingOverrides;
}

/**
 * A declarative field spec, mirroring `PickStringOptions` so a `match`-based
 * source can reach nested payloads and control env-vs-payload precedence exactly
 * like the built-in resolvers do.
 */
export interface SourceMatchField {
  envKeys?: string[];
  payloadKeys?: string[];
  nestedPayloadKeys?: string[];
  payloadFirst?: boolean;
}

export interface SourceMatchSpec {
  sessionId?: SourceMatchField;
  project?: SourceMatchField;
  event?: SourceMatchField;
}

/**
 * A configured presence source, keyed by source id in the merged source table.
 *
 * Resolution order within one entry: `enabled: false` disables the source;
 * otherwise `handler` (an npm specifier, absolute path, or the `builtin:<id>`
 * form that reuses a shipped resolver) wins over the no-code `match` spec.
 *
 * The shipped `sources.default.json` provides the five built-ins as
 * `{ handler: "builtin:<id>" }`. A user's `config.plugins.sources` is merged
 * over those defaults by id: a same-id entry overrides the default (letting a
 * user retarget or disable a built-in), and a new id adds a source.
 */
export interface SourcePluginConfig {
  handler?: string;
  match?: SourceMatchSpec;
  /** Set false to drop this source from the merged table. Defaults to true. */
  enabled?: boolean;
}

export interface PluginsConfig {
  /** Presence sources keyed by source id, merged over the shipped defaults. */
  sources?: Record<string, SourcePluginConfig>;
}

export interface AppConfig {
  provider?: ProviderId | 'l-garyyang';
  providerBaseUrl?: string;
  previewBaseUrl?: string;
  previewImageKey?: string;
  previewTargetUrl?: string;
  providers?: {
    'feishu-signature'?: FeishuSignatureProviderConfig;
    'magic-builder'?: MagicBuilderProviderConfig;
  };
  slot_id?: string;
  slotId?: string;
  ttlMs?: number;
  debounceMs?: number;
  render?: RenderTemplates;
  usage?: UsageConfig;
  plugins?: PluginsConfig;
}

export function getDefaultHomeDir(): string {
  return join(homedir(), '.agent-presence');
}

export function getLegacyHomeDir(): string {
  return join(homedir(), '.codex', 'agent-signature');
}

export function getHomeDir(): string {
  return process.env.AGENT_PRESENCE_HOME ?? process.env.AGENT_SIGNATURE_HOME ?? getDefaultHomeDir();
}

export function getConfigPath(): string {
  return process.env.AGENT_PRESENCE_CONFIG_FILE ?? process.env.AGENT_SIGNATURE_CONFIG_FILE ?? join(getHomeDir(), 'config.json');
}

export function getStatePath(): string {
  return process.env.AGENT_PRESENCE_STATE_FILE ?? process.env.AGENT_SIGNATURE_STATE_FILE ?? join(getHomeDir(), 'state.json');
}

export function getLogPath(): string {
  return process.env.AGENT_PRESENCE_LOG_FILE ?? process.env.AGENT_SIGNATURE_LOG_FILE ?? join(getHomeDir(), 'agent-presence.log');
}

/**
 * Directory that holds user-installed source plugins. `source add` runs
 * `npm install` with this as the prefix, so packages land under
 * `<pluginsDir>/node_modules`, isolated from the CLI's own install and from any
 * project the user is in.
 */
export function getPluginsDir(): string {
  return process.env.AGENT_PRESENCE_PLUGINS_DIR ?? join(getHomeDir(), 'plugins');
}

export async function loadConfig(configPath = getConfigPath()): Promise<AppConfig> {
  if (configPath === getConfigPath() && !hasExplicitConfigPath() && !existsSync(configPath)) {
    const legacyConfigPath = join(getLegacyHomeDir(), 'config.json');
    if (existsSync(legacyConfigPath)) {
      return readJsonFile<AppConfig>(legacyConfigPath, {});
    }
  }
  return readJsonFile<AppConfig>(configPath, {});
}

export async function saveConfig(config: AppConfig, configPath = getConfigPath()): Promise<void> {
  await writeJsonAtomic(configPath, config);
}

export function providerId(config: AppConfig, explicitProvider?: string): ProviderId {
  const value =
    explicitProvider ??
    process.env.AGENT_PRESENCE_PROVIDER ??
    process.env.AGENT_SIGNATURE_PROVIDER ??
    config.provider ??
    DEFAULT_PROVIDER_ID;
  if (value === 'feishu-signature' || value === 'l-garyyang') {
    return 'feishu-signature';
  }
  if (value === 'magic-builder') {
    return 'magic-builder';
  }
  throw new Error(`unsupported provider: ${value}`);
}

export function magicBuilderConfig(config: AppConfig): MagicBuilderProviderConfig {
  return config.providers?.['magic-builder'] ?? {};
}

export function magicBuilderBaseUrl(config: AppConfig): string {
  return (
    process.env.AGENT_PRESENCE_MAGIC_BUILDER_BASE_URL ??
    process.env.MAGIC_BASE_URL ??
    magicBuilderConfig(config).baseUrl ??
    DEFAULT_MAGIC_BUILDER_BASE_URL
  );
}

export function magicBuilderFaasId(config: AppConfig): string | undefined {
  return process.env.AGENT_PRESENCE_MAGIC_BUILDER_FAAS_ID ?? magicBuilderConfig(config).faasId;
}

export function magicBuilderFaasName(config: AppConfig): string | undefined {
  return process.env.AGENT_PRESENCE_MAGIC_BUILDER_FAAS_NAME ?? magicBuilderConfig(config).faasName;
}

export function magicBuilderFallbackTitle(config: AppConfig): string {
  return (
    process.env.AGENT_PRESENCE_MAGIC_BUILDER_FALLBACK_TITLE ??
    magicBuilderConfig(config).fallbackTitle ??
    config.render?.zero ??
    'AI 牛马暂未开工'
  );
}

export function setMagicBuilderConfig(config: AppConfig, patch: Partial<MagicBuilderProviderConfig>): AppConfig {
  const next: AppConfig = { ...config };
  const providers = { ...(next.providers ?? {}) };
  const existing = providers['magic-builder'] ?? {};
  providers['magic-builder'] = { ...existing, ...patch };
  next.providers = providers;
  return next;
}

export function feishuSignatureConfig(config: AppConfig): FeishuSignatureProviderConfig {
  const providerConfig = config.providers?.['feishu-signature'] ?? {};
  return {
    baseUrl: providerConfig.baseUrl ?? config.providerBaseUrl,
    previewBaseUrl: providerConfig.previewBaseUrl ?? config.previewBaseUrl,
    previewImageKey: providerConfig.previewImageKey ?? config.previewImageKey,
    previewTargetUrl: providerConfig.previewTargetUrl ?? config.previewTargetUrl
  };
}

export function providerBaseUrl(config: AppConfig): string {
  const providerConfig = feishuSignatureConfig(config);
  return (
    process.env.AGENT_PRESENCE_FEISHU_SIGNATURE_BASE_URL ??
    process.env.AGENT_PRESENCE_PROVIDER_BASE_URL ??
    process.env.AGENT_SIGNATURE_PROVIDER_BASE_URL ??
    providerConfig.baseUrl ??
    DEFAULT_PROVIDER_BASE_URL
  );
}

export function previewBaseUrl(config: AppConfig): string {
  const providerConfig = feishuSignatureConfig(config);
  return (
    process.env.AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_BASE_URL ??
    process.env.AGENT_PRESENCE_PREVIEW_BASE_URL ??
    process.env.AGENT_SIGNATURE_PREVIEW_BASE_URL ??
    providerConfig.previewBaseUrl ??
    DEFAULT_PREVIEW_BASE_URL
  );
}

export function previewImageKey(config: AppConfig): string | undefined {
  const providerConfig = feishuSignatureConfig(config);
  return (
    process.env.AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_IMAGE_KEY ??
    process.env.AGENT_PRESENCE_PREVIEW_IMAGE_KEY ??
    process.env.AGENT_SIGNATURE_PREVIEW_IMAGE_KEY ??
    providerConfig.previewImageKey
  );
}

export function previewTargetUrl(config: AppConfig): string | undefined {
  const providerConfig = feishuSignatureConfig(config);
  return (
    process.env.AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_TARGET_URL ??
    process.env.AGENT_PRESENCE_PREVIEW_TARGET_URL ??
    process.env.AGENT_SIGNATURE_PREVIEW_TARGET_URL ??
    providerConfig.previewTargetUrl
  );
}

export function ttlMs(config: AppConfig): number {
  return readPositiveInt(process.env.AGENT_PRESENCE_TTL_MS) ?? readPositiveInt(process.env.AGENT_SIGNATURE_TTL_MS) ?? config.ttlMs ?? DEFAULT_TTL_MS;
}

export function debounceMs(config: AppConfig): number {
  return readPositiveInt(process.env.AGENT_PRESENCE_DEBOUNCE_MS) ?? readPositiveInt(process.env.AGENT_SIGNATURE_DEBOUNCE_MS) ?? config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
}

export function renderTemplates(config: AppConfig): RenderTemplates {
  const templates: RenderTemplates = {};
  setDefinedTemplate(templates, 'zero', process.env.AGENT_PRESENCE_RENDER_ZERO ?? process.env.AGENT_SIGNATURE_RENDER_ZERO ?? config.render?.zero);
  setDefinedTemplate(templates, 'one', process.env.AGENT_PRESENCE_RENDER_ONE ?? process.env.AGENT_SIGNATURE_RENDER_ONE ?? config.render?.one);
  setDefinedTemplate(templates, 'many', process.env.AGENT_PRESENCE_RENDER_MANY ?? process.env.AGENT_SIGNATURE_RENDER_MANY ?? config.render?.many);
  return templates;
}

export function usageShowInSignature(config: AppConfig): boolean {
  const env = process.env.AGENT_PRESENCE_USAGE_IN_SIGNATURE;
  if (env !== undefined) {
    return env === '1' || env.toLowerCase() === 'true';
  }
  return config.usage?.showInSignature ?? false;
}

export function usageSignatureWindowDays(config: AppConfig): number {
  return readPositiveInt(process.env.AGENT_PRESENCE_USAGE_WINDOW_DAYS) ?? config.usage?.signatureWindowDays ?? 1;
}

export function usagePricingOverrides(config: AppConfig): PricingOverrides {
  return config.usage?.pricing ?? {};
}

export function pluginSourcesConfig(config: AppConfig): Record<string, SourcePluginConfig> {
  return config.plugins?.sources ?? {};
}

/** Return a copy of `config` with the source `id` set to `entry`. */
export function setPluginSource(config: AppConfig, id: string, entry: SourcePluginConfig): AppConfig {
  const next: AppConfig = { ...config };
  const plugins = { ...(next.plugins ?? {}) };
  plugins.sources = { ...(plugins.sources ?? {}), [id]: entry };
  next.plugins = plugins;
  return next;
}

/** Return a copy of `config` with the source `id` removed from `plugins.sources`. */
export function removePluginSource(config: AppConfig, id: string): AppConfig {
  const next: AppConfig = { ...config };
  if (!next.plugins?.sources || !(id in next.plugins.sources)) {
    return next;
  }
  const sources = { ...next.plugins.sources };
  delete sources[id];
  const plugins = { ...next.plugins };
  if (Object.keys(sources).length > 0) {
    plugins.sources = sources;
  } else {
    delete plugins.sources;
  }
  next.plugins = Object.keys(plugins).length > 0 ? plugins : undefined;
  return next;
}

export function configSlotId(config: AppConfig): string | undefined {
  return (
    process.env.AGENT_PRESENCE_SLOT_ID ??
    process.env.AGENT_PRESENCE_L_GARYYANG_SLOT_ID ??
    process.env.AGENT_SIGNATURE_SLOT_ID ??
    process.env.AGENT_SIGNATURE_L_GARYYANG_SLOT_ID ??
    config.slotId ??
    config.slot_id
  );
}

export function readPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function setDefinedTemplate(templates: RenderTemplates, key: keyof RenderTemplates, value: string | undefined): void {
  if (value !== undefined) {
    templates[key] = value;
  }
}

function hasExplicitConfigPath(): boolean {
  return Boolean(process.env.AGENT_PRESENCE_CONFIG_FILE ?? process.env.AGENT_SIGNATURE_CONFIG_FILE);
}
