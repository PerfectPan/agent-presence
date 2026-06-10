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
import { readMagicToken, writeMagicToken, type MagicTokenSource } from '../magic-token.js';
import {
  DEFAULT_MAGIC_BUILDER_FAAS_NAME,
  MagicBuilderProvider,
  type MagicBuilderPublishResult
} from '../providers/magic-builder.js';
import { readCredential } from '../secret.js';

export const MAGIC_TOKEN_HELP =
  'How to get your Magic-Builder token:\n' +
  '  1) In Feishu, open the 妙笔 bot: https://applink.larkoffice.com/T94fcr4NqQPz\n' +
  '  2) Send the message: dev\n' +
  '  3) Copy the token it replies with.\n' +
  'Then either re-run setup in an interactive terminal to paste it, or set it manually:\n' +
  '  export MAGIC_TOKEN=<token>            # one-off\n' +
  '  echo <token> > ~/.magic-token         # plaintext file (skill-pack compatible)';

export interface PublishMagicBuilderFaasOptions {
  /** Override the FaaS function name (default: `agent_presence_preview`). */
  name?: string;
  /** Pass false to skip persisting the new record id back to config.json. */
  persist?: boolean;
  /**
   * Called when no token is found in env/keyring/file. Return a token to
   * persist it to the OS keyring and continue, or undefined to abort with the
   * standard missing-token error. Enables an interactive paste prompt without
   * coupling this module to the CLI prompt layer.
   */
  acquireToken?: () => Promise<string | undefined>;
}

export interface PublishMagicBuilderFaasResult extends MagicBuilderPublishResult {
  url: string;
  isUpdate: boolean;
  tokenSource: MagicTokenSource;
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
  let tokenInfo = await readMagicToken();
  if ((!tokenInfo.token || !tokenInfo.source) && options.acquireToken) {
    const entered = (await options.acquireToken())?.trim();
    if (entered) {
      await writeMagicToken(entered);
      tokenInfo = { token: entered, source: 'keychain' };
    }
  }
  if (!tokenInfo.token || !tokenInfo.source) {
    throw new Error(`missing magic-builder token.\n${MAGIC_TOKEN_HELP}`);
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
