import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SlotCredential {
  token: string;
  slotId: string;
}

const SERVICE = 'agent-signature:l-garyyang';
const LEGACY_SERVICE = 'agent-signature-slot-credential';
const LIBSECRET_SERVICE = 'agent-presence';
const LIBSECRET_ERROR =
  'agent-presence requires libsecret on linux (install gnome-keyring or libsecret-tools)';

export async function readCredential(configSlotId?: string): Promise<SlotCredential | undefined> {
  const token = await resolveToken();
  const slotId = await resolveSlotId(configSlotId);

  if (!token || !slotId) {
    return undefined;
  }

  return { token, slotId };
}

export async function writeCredential(credential: SlotCredential): Promise<void> {
  if (process.platform === 'linux') {
    await ensureSecretTool();
    await writeSecretTool('token', credential.token);
    await writeSecretTool('slotId', credential.slotId);
    return;
  }

  await writeKeychain(SERVICE, 'token', credential.token);
  await writeKeychain(SERVICE, 'slotId', credential.slotId);
}

export async function deleteCredential(): Promise<void> {
  if (process.platform === 'linux') {
    await ensureSecretTool();
    await deleteSecretTool('token');
    await deleteSecretTool('slotId');
    return;
  }

  await Promise.all([
    deleteKeychain(SERVICE, 'token'),
    deleteKeychain(SERVICE, 'slotId'),
    deleteKeychain(LEGACY_SERVICE, process.env.USER ?? 'agent-presence')
  ]);
}

async function resolveToken(): Promise<string | undefined> {
  const envToken =
    process.env.AGENT_PRESENCE_L_GARYYANG_TOKEN ??
    process.env.AGENT_PRESENCE_TOKEN ??
    process.env.AGENT_SIGNATURE_L_GARYYANG_TOKEN ??
    process.env.AGENT_SIGNATURE_TOKEN ??
    process.env.FEISHU_SLOT_CREDENTIAL;

  if (envToken) {
    return envToken;
  }

  if (process.platform === 'linux') {
    return (await readPlatformToken()) ?? undefined;
  }

  return (await readKeychain(SERVICE, 'token')) ?? (await readKeychain(LEGACY_SERVICE, process.env.USER ?? 'agent-presence'));
}

async function readPlatformToken(): Promise<string | undefined> {
  await ensureSecretTool();
  return readSecretTool('token');
}

async function resolveSlotId(configSlotId?: string): Promise<string | undefined> {
  const envSlotId =
    process.env.AGENT_PRESENCE_L_GARYYANG_SLOT_ID ??
    process.env.AGENT_PRESENCE_SLOT_ID ??
    process.env.AGENT_SIGNATURE_L_GARYYANG_SLOT_ID ??
    process.env.AGENT_SIGNATURE_SLOT_ID;

  if (envSlotId) {
    return envSlotId;
  }

  if (process.platform === 'linux') {
    return (await readPlatformSlotId()) ?? configSlotId;
  }

  return (await readKeychain(SERVICE, 'slotId')) ?? configSlotId;
}

async function readPlatformSlotId(): Promise<string | undefined> {
  await ensureSecretTool();
  return readSecretTool('slotId');
}

async function ensureSecretTool(): Promise<void> {
  if (!(await hasSecretTool())) {
    throw new Error(LIBSECRET_ERROR);
  }
}

async function hasSecretTool(): Promise<boolean> {
  try {
    await execFileAsync('secret-tool', ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function readSecretTool(account: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', LIBSECRET_SERVICE, 'account', account], {
      encoding: 'utf8'
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function writeSecretTool(account: string, value: string): Promise<void> {
  // execFile supports `input` at runtime but @types/node excludes it from overloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await execFileAsync('secret-tool', ['store', '--label', LIBSECRET_SERVICE, 'service', LIBSECRET_SERVICE, 'account', account], { input: value } as any);
}

async function deleteSecretTool(account: string): Promise<void> {
  await execFileAsync('secret-tool', ['clear', 'service', LIBSECRET_SERVICE, 'account', account]).catch(() => undefined);
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

async function deleteKeychain(service: string, account: string): Promise<void> {
  await execFileAsync('security', ['delete-generic-password', '-s', service, '-a', account]).catch(() => undefined);
}
