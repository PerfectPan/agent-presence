export type StringEnv = Record<string, string | undefined>;

interface PickStringOptions {
  env?: StringEnv;
  envKeys?: string[];
  payloadKeys?: string[];
  nestedPayloadKeys?: string[];
  payloadFirst?: boolean;
}

export function pickString(payload: unknown, options: PickStringOptions): string | undefined {
  const envKeys = options.envKeys ? options.envKeys : [];
  const payloadKeys = options.payloadKeys ? options.payloadKeys : [];
  if (options.payloadFirst) {
    const payloadValue = findPayloadString(payload, payloadKeys, options.nestedPayloadKeys);
    return payloadValue ? payloadValue : pickEnvString(options.env, envKeys);
  }

  const envValue = pickEnvString(options.env, envKeys);
  return envValue ? envValue : findPayloadString(payload, payloadKeys, options.nestedPayloadKeys);
}

function pickEnvString(env: StringEnv | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env?.[key];
    if (isNonEmptyString(value)) {
      return value;
    }
  }

  return undefined;
}

export function findPayloadString(payload: unknown, keys: string[], nestedKeys: string[] = []): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  for (const key of keys) {
    const value = payload[key];
    if (isNonEmptyString(value)) {
      return value;
    }
  }

  for (const key of nestedKeys) {
    const found = findPayloadString(payload[key], keys, nestedKeys);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
