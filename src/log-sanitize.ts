export function redactSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) {
    return undefined;
  }
  if (sessionId.length <= 12) {
    return sessionId;
  }
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

export function redactSlotId(slotId: string | undefined): string | undefined {
  if (!slotId) {
    return undefined;
  }
  return slotId.length <= 12 ? `${slotId.slice(0, 4)}...` : `${slotId.slice(0, 12)}...`;
}

export function valueLength(value: string | undefined): number | undefined {
  return typeof value === 'string' ? value.length : undefined;
}
