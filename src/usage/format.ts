/** Render a token count compactly: 950 → "950", 12_300 → "12.3K", 1_250_000 → "1.25M". */
export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${trim(n / 1000)}K`;
  }
  if (n < 1_000_000_000) {
    return `${trim(n / 1_000_000)}M`;
  }
  return `${trim(n / 1_000_000_000)}B`;
}

/** Render a USD cost, or "n/a" when the cost is unknown (no pricing for the model). */
export function formatCost(usd: number | null): string {
  if (usd === null) {
    return 'n/a';
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * Compact badge for embedding in the signature, e.g. "2.1M · $4.50". Cost is
 * omitted when unknown so the badge never shows a misleading number.
 */
export function renderUsageBadge(totalTokens: number, costUsd: number | null): string {
  const tokens = formatTokens(totalTokens);
  return costUsd === null ? tokens : `${tokens} · ${formatCost(costUsd)}`;
}

function trim(value: number): string {
  // One decimal place, but drop a trailing ".0" so 1.0M reads as "1M".
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
}
