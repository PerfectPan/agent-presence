import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SlotCredential {
  token: string;
  slotId: string;
}

const SERVICE = 'agent-signature:l-garyyang';
const LEGACY_SERVICE = 'agent-signature-slot-credential';

export async function readCredential(configSlotId?: string): Promise<SlotCredential | undefined> {
  const token =
    process.env.AGENT_PRESENCE_L_GARYYANG_TOKEN ??
    process.env.AGENT_PRESENCE_TOKEN ??
    process.env.AGENT_SIGNATURE_L_GARYYANG_TOKEN ??
    process.env.AGENT_SIGNATURE_TOKEN ??
    process.env.FEISHU_SLOT_CREDENTIAL ??
    (await readKeychain(SERVICE, 'token')) ??
    (await readKeychain(LEGACY_SERVICE, process.env.USER ?? 'agent-presence'));

  const slotId =
    process.env.AGENT_PRESENCE_L_GARYYANG_SLOT_ID ??
    process.env.AGENT_PRESENCE_SLOT_ID ??
    process.env.AGENT_SIGNATURE_L_GARYYANG_SLOT_ID ??
    process.env.AGENT_SIGNATURE_SLOT_ID ??
    (await readKeychain(SERVICE, 'slotId')) ??
    configSlotId;

  if (!token || !slotId) {
    return undefined;
  }

  return { token, slotId };
}

export async function writeCredential(credential: SlotCredential): Promise<void> {
  await writeKeychain(SERVICE, 'token', credential.token);
  await writeKeychain(SERVICE, 'slotId', credential.slotId);
}

async function readKeychain(service: string, account: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8'
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function writeKeychain(service: string, account: string, value: string): Promise<void> {
  await execFileAsync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
}
