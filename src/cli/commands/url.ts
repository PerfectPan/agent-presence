import { configSlotId, loadConfig, previewBaseUrl, previewImageKey, previewTargetUrl, providerBaseUrl, providerId } from '../../config.js';
import { LGaryYangProvider } from '../../providers/l-garyyang.js';
import { readCredential } from '../../secret.js';
import { optionValue } from '../args.js';

export async function resolveSignatureUrl(args: string[] = []): Promise<string> {
  const config = await loadConfig();
  providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const slotId = credential?.slotId ?? configSlotId(config);
  if (!slotId) {
    throw new Error('missing slot_id; run `agent-presence login` first');
  }

  const provider = new LGaryYangProvider(providerBaseUrl(config), credential);
  return provider.buildSignatureUrl({
    slotId,
    imageKey: previewImageKey(config),
    targetUrl: previewTargetUrl(config),
    previewBaseUrl: previewBaseUrl(config)
  });
}

export async function printSignatureUrl(args: string[] = []): Promise<void> {
  console.log(await resolveSignatureUrl(args));
}
