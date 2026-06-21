import { DEFAULT_LOGIN_POLL_MS, getConfigPath, loadConfig, providerId, saveConfig } from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsLogin } from '../../providers/types.js';
import { writeCredential } from '../../secret.js';
import { optionValue } from '../args.js';
import { sleep } from '../sleep.js';
import { createSpinner, finishOutro, showNote, startIntro } from '../ui.js';

export async function login(args: string[] = []): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const provider = createProvider(activeProvider, { config });
  assertSupportsLogin(provider);

  startIntro('Agent Presence login');
  const qrSpinner = createSpinner();
  qrSpinner.start('Requesting login QR code');
  const qr = await provider.createQrCode();
  qrSpinner.stop('QR code ready');

  const expiresAt = Date.now() + qr.expiresIn * 1000;
  showNote(`sceneId: ${qr.sceneId}\nqrcode: ${qr.qrcodeUrl}`, 'Scan the QR code');

  const pollSpinner = createSpinner();
  pollSpinner.start('Waiting for authorization');
  while (Date.now() < expiresAt) {
    const status = await provider.getLoginStatus(qr.sceneId);
    if ('token' in status) {
      await writeCredential({ token: status.token, slotId: status.slotId });
      await saveConfig({ ...config, provider: activeProvider, slot_id: status.slotId }, getConfigPath());
      pollSpinner.stop('Authorization complete');
      finishOutro(`login: ok\nslot_id: ${status.slotId}`);
      return;
    }

    if (status.status === 'expired') {
      pollSpinner.error('QR code expired');
      throw new Error('login qrcode expired before authorization completed');
    }

    if (status.status === 'confirmed' || status.status === 'authorized' || status.status === 'success') {
      pollSpinner.error('Authorization response missing credential');
      throw new Error('login authorization completed but provider did not return credential and slot id');
    }

    await sleep(DEFAULT_LOGIN_POLL_MS);
  }

  pollSpinner.error('QR code expired');
  throw new Error('login qrcode expired before authorization completed');
}
