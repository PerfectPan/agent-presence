import { configSlotId } from '../config.js';
import { loadValidatedConfig } from '../config-schema.js';
import { readCredential } from '../secret.js';

export async function hasCredential(): Promise<boolean> {
  const { config } = await loadValidatedConfig();
  const credential = await readCredential(configSlotId(config));
  return Boolean(credential?.token && credential.slotId);
}
