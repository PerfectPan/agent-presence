import { loadConfig, usagePricingOverrides } from '../../config.js';
import { formatCost, formatTokens } from '../../usage/format.js';
import { collectWindowUsage, type UsageSource, type WindowUsage } from '../../usage/index.js';
import { hasFlag, optionValue } from '../args.js';

const SOURCE_LABEL: Record<UsageSource, string> = {
  claude: 'claude',
  codex: 'codex',
  pi: 'pi'
};

export async function printUsage(args: string[]): Promise<void> {
  const config = await loadConfig();
  const pricing = usagePricingOverrides(config);
  const now = Date.now();

  const explicitDays = readDays(optionValue(args, '--days'));
  const windowDays = explicitDays !== undefined ? [explicitDays] : [1, 7];

  const windows = await Promise.all(
    windowDays.map((days) => collectWindowUsage({ days, now, pricing }))
  );

  if (hasFlag(args, '--json')) {
    const payload = windowDays.map((days, index) => ({ days, ...windows[index] }));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(renderTable(windowDays, windows));
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

function renderTable(windowDays: number[], windows: WindowUsage[]): string {
  const sources: UsageSource[] = ['claude', 'codex', 'pi'];
  const lines: string[] = [];
  lines.push('agent-presence usage — token consumption (rolling window)');
  lines.push('');

  // Header: one "tokens / cost" pair per window.
  const headerCells = ['source'];
  for (const days of windowDays) {
    headerCells.push(`last ${days}d tokens`, `last ${days}d cost`);
  }

  const rows: string[][] = [headerCells];
  for (const source of sources) {
    const cells = [SOURCE_LABEL[source]];
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
  lines.push('');
  lines.push('gemini: not tracked (no local per-message token log)');
  return lines.join('\n');
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
