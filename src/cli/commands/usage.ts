import { loadConfig, usagePricingOverrides } from '../../config.js';
import { billableSources } from '../../sources.js';
import { formatCost, formatTokens } from '../../usage/format.js';
import { collectWindowUsage, type WindowUsage } from '../../usage/index.js';
import { hasFlag, optionValue } from '../args.js';

export async function printUsage(args: string[]): Promise<void> {
  const config = await loadConfig();
  const pricing = usagePricingOverrides(config);
  const now = Date.now();

  // Resolve the billable sources once (handlers included — the standalone
  // command is the interactive path), so every window shares the same set and
  // order.
  const sources = await billableSources(config);

  const explicitDays = readDays(optionValue(args, '--days'));
  const windowDays = explicitDays !== undefined ? [explicitDays] : [1, 7];

  const windows = await Promise.all(
    windowDays.map((days) => collectWindowUsage({ days, now, pricing, sources }))
  );

  if (hasFlag(args, '--json')) {
    const payload = windowDays.map((days, index) => ({ days, ...windows[index] }));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(renderUsageTable(windowDays, windows));
}

function readDays(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid --days value: ${value}`);
  }
  return parsed;
}

/**
 * Render the human-readable usage table. Exported for tests: the source rows are
 * dynamic (whatever the merged source table produced), one row per source in
 * merged-table order, labelled by the source id itself.
 */
export function renderUsageTable(windowDays: number[], windows: WindowUsage[]): string {
  // Sources come from the merged source table (in table order), so the row set
  // is dynamic. Take the union of ids seen across windows, preserving the order
  // each window reports them in. The row label is the source id itself.
  const sources = orderedSources(windows);
  const lines: string[] = [];
  lines.push('agent-presence usage — token consumption (calendar-day window)');
  lines.push('');

  // Header: one "tokens / cost" pair per window.
  const headerCells = ['source'];
  for (const days of windowDays) {
    headerCells.push(`last ${days}d tokens`, `last ${days}d cost`);
  }

  const rows: string[][] = [headerCells];
  for (const source of sources) {
    const cells = [source];
    for (const window of windows) {
      const group = window.bySource.find((entry) => entry.source === source);
      cells.push(
        group ? formatTokens(group.totalTokens) : '0',
        group ? formatCost(group.costUsd) : 'n/a'
      );
    }
    rows.push(cells);
  }

  const totalCells = ['total'];
  for (const window of windows) {
    totalCells.push(formatTokens(window.total.totalTokens), formatCost(window.total.costUsd));
  }

  const widths = columnWidths([...rows, totalCells]);
  for (const row of rows) {
    lines.push(formatRow(row, widths));
  }
  lines.push(divider(widths));
  lines.push(formatRow(totalCells, widths));
  return lines.join('\n');
}

/** Union of source ids across windows, in first-seen (merged-table) order. */
export function orderedSources(windows: WindowUsage[]): string[] {
  const seen = new Set<string>();
  for (const window of windows) {
    for (const entry of window.bySource) {
      seen.add(entry.source);
    }
  }
  return [...seen];
}

function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return widths;
}

function formatRow(row: string[], widths: number[]): string {
  return row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
}

function divider(widths: number[]): string {
  return widths.map((width) => '─'.repeat(width)).join('  ');
}
