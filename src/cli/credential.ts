import { configSlotId, loadConfig } from '../config.js';
import { readCredential } from '../secret.js';

export async function hasCredential(): Promise<boolean> {
  const config = await loadConfig();
  const credential = await readCredential(configSlotId(config));
  return Boolean(credential?.token && credential.slotId);
}
