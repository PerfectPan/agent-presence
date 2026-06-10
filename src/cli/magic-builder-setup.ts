import {
  configSlotId,
  getConfigPath,
  loadConfig,
  magicBuilderBaseUrl,
  magicBuilderConfig,
  magicBuilderFaasId,
  magicBuilderFaasName,
  magicBuilderFallbackTitle,
  providerBaseUrl,
  saveConfig,
  setMagicBuilderConfig
} from '../config.js';
import { readMagicToken } from '../magic-token.js';
import {
  DEFAULT_MAGIC_BUILDER_FAAS_NAME,
  MagicBuilderProvider,
  type MagicBuilderPublishResult
} from '../providers/magic-builder.js';
import { readCredential } from '../secret.js';

export interface PublishMagicBuilderFaasOptions {
  /** Override the FaaS function name (default: `agent_presence_preview`). */
  name?: string;
  /** Pass false to skip persisting the new record id back to config.json. */
  persist?: boolean;
}

export interface PublishMagicBuilderFaasResult extends MagicBuilderPublishResult {
  url: string;
  isUpdate: boolean;
  tokenSource: 'env' | 'file';
  tokenPath?: string;
}

/**
 * Reads the magic-builder token, fetches the user's l.garyyang credential,
 * renders a fresh FaaS source with the slot id + bearer embedded, and POSTs
 * it to magic.solutionsuite.cn/api/faas. New record ids are persisted so
 * subsequent runs reuse the same FaaS record (idempotent setup).
 */
export async function publishMagicBuilderFaas(
  options: PublishMagicBuilderFaasOptions = {}
): Promise<PublishMagicBuilderFaasResult> {
  const config = await loadConfig();
  const tokenInfo = await readMagicToken();
  if (!tokenInfo.token || !tokenInfo.source) {
    throw new Error(
      'missing magic-builder token. Provide it one of two ways:\n' +
        '  1) export MAGIC_TOKEN=<your-token>\n' +
        '  2) echo <your-token> > ~/.magic-token && chmod 600 ~/.magic-token\n' +
        'Get the token from https://magic.solutionsuite.cn after Feishu SSO login.'
    );
  }

  const credential = await readCredential(configSlotId(config));
  if (!credential?.token || !credential.slotId) {
    throw new Error(
      'missing l.garyyang slot credential; run `agent-presence login --provider feishu-signature` first so the published FaaS can read your slot value.'
    );
  }

  const baseUrl = magicBuilderBaseUrl(config);
  const provider = new MagicBuilderProvider(baseUrl, tokenInfo.token);
  const existingRecordId = magicBuilderFaasId(config);
  const name = options.name ?? magicBuilderFaasName(config) ?? DEFAULT_MAGIC_BUILDER_FAAS_NAME;

  const code = provider.buildFaasCode({
    slotId: credential.slotId,
    slotBearer: credential.token,
    slotBaseUrl: providerBaseUrl(config),
    fallbackTitle: magicBuilderFallbackTitle(config)
  });

  const result = await provider.publishFaas({
    code,
    name,
    recordId: existingRecordId
  });

  const persist = options.persist ?? true;
  if (persist) {
    const existingProviderConfig = magicBuilderConfig(config);
    const updated = setMagicBuilderConfig(config, {
      faasId: result.id,
      faasName: name,
      baseUrl: existingProviderConfig.baseUrl ?? (baseUrl === 'https://magic.solutionsuite.cn' ? undefined : baseUrl)
    });
    if (!updated.provider) {
      updated.provider = 'magic-builder';
    }
    await saveConfig(updated, getConfigPath());
  }

  return {
    ...result,
    url: provider.buildSignatureUrl(result.id),
    isUpdate: Boolean(existingRecordId),
    tokenSource: tokenInfo.source,
    tokenPath: tokenInfo.path
  };
}
