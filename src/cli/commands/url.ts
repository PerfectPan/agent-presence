import {
  configSlotId,
  loadConfig,
  magicBuilderBaseUrl,
  magicBuilderFaasId,
  previewBaseUrl,
  previewImageKey,
  previewTargetUrl,
  providerBaseUrl,
  providerId
} from '../../config.js';
import { LGaryYangProvider } from '../../providers/l-garyyang.js';
import { MagicBuilderProvider } from '../../providers/magic-builder.js';
import { readCredential } from '../../secret.js';
import { optionValue } from '../args.js';

export async function resolveSignatureUrl(args: string[] = []): Promise<string> {
  const config = await loadConfig();
  const provider = providerId(config, optionValue(args, '--provider'));

  if (provider === 'magic-builder') {
    const faasId = magicBuilderFaasId(config);
    if (!faasId) {
      throw new Error(
        'magic-builder provider has no published FaaS yet; run `agent-presence setup --provider magic-builder` first'
      );
    }
    return new MagicBuilderProvider(magicBuilderBaseUrl(config)).buildSignatureUrl(faasId);
  }

  const credential = await readCredential(configSlotId(config));
  const slotId = credential?.slotId ?? configSlotId(config);
  if (!slotId) {
    throw new Error('missing slot_id; run `agent-presence login` first');
  }

  const lgaryyang = new LGaryYangProvider(providerBaseUrl(config), credential);
  return lgaryyang.buildSignatureUrl({
    slotId,
    imageKey: previewImageKey(config),
    targetUrl: previewTargetUrl(config),
    previewBaseUrl: previewBaseUrl(config)
  });
}

export async function printSignatureUrl(args: string[] = []): Promise<void> {
  console.log(await resolveSignatureUrl(args));
}
