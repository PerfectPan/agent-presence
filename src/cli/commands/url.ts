import { configSlotId, loadConfig, providerId } from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsSignatureUrl } from '../../providers/types.js';
import { readCredential } from '../../secret.js';
import { optionValue } from '../args.js';

export async function resolveSignatureUrl(args: string[] = []): Promise<string> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = createProvider(activeProvider, { config, credential });
  assertSupportsSignatureUrl(provider);
  return provider.buildSignatureUrl();
}

export async function printSignatureUrl(args: string[] = []): Promise<void> {
  console.log(await resolveSignatureUrl(args));
}
