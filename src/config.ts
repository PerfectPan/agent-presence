import { join } from 'node:path';
import { homedir } from 'node:os';
import { readJsonFile, writeJsonAtomic } from './json-file.js';
import type { RenderTemplates } from './render.js';

export const DEFAULT_PROVIDER_BASE_URL = 'https://l.garyyang.work';
export const DEFAULT_PREVIEW_BASE_URL = 'https://l.garyyang.work/';
export const DEFAULT_TTL_MS = 3 * 60 * 1000;
export const DEFAULT_DEBOUNCE_MS = 60 * 1000;
export const DEFAULT_LOGIN_POLL_MS = 3 * 1000;
export const DEFAULT_PROVIDER_ID = 'feishu-signature';

export type ProviderId = 'feishu-signature';

export interface FeishuSignatureProviderConfig {
  baseUrl?: string;
  previewBaseUrl?: string;
  previewImageKey?: string;
  previewTargetUrl?: string;
}

export interface AppConfig {
  provider?: ProviderId | 'l-garyyang';
  providerBaseUrl?: string;
  previewBaseUrl?: string;
  previewImageKey?: string;
  previewTargetUrl?: string;
  providers?: {
    'feishu-signature'?: FeishuSignatureProviderConfig;
  };
  slot_id?: string;
  slotId?: string;
  ttlMs?: number;
  debounceMs?: number;
  render?: RenderTemplates;
}

export function getHomeDir(): string {
  return process.env.AGENT_PRESENCE_HOME ?? process.env.AGENT_SIGNATURE_HOME ?? join(homedir(), '.codex', 'agent-signature');
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

export async function loadConfig(configPath = getConfigPath()): Promise<AppConfig> {
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
  throw new Error(`unsupported provider: ${value}`);
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
