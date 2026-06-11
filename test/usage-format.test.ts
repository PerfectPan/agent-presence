import { describe, expect, it } from 'vitest';
import { formatCost, formatTokens, renderUsageBadge } from '../src/usage/format.js';

describe('formatTokens', () => {
  it('renders compact magnitudes', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3K');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(2_500_000_000)).toBe('2.5B');
  });
});

describe('formatCost', () => {
  it('renders USD with two decimals, or n/a when unknown', () => {
    expect(formatCost(3.4)).toBe('$3.40');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(null)).toBe('n/a');
  });
});

describe('renderUsageBadge', () => {
  it('combines tokens and cost, omitting cost when unknown', () => {
    expect(renderUsageBadge(2_100_000, 4.5)).toBe('2.1M · $4.50');
    expect(renderUsageBadge(2_100_000, null)).toBe('2.1M');
  });
});
