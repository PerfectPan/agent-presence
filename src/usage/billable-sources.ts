import type { AppConfig } from '../config.js';
import { mergedSources, resolveSourcePlugin } from '../sources.js';
import { scanClaude } from './scan-claude.js';
import { scanCodex } from './scan-codex.js';
import { scanDsh } from './scan-dsh.js';
import { scanGemini } from './scan-gemini.js';
import { scanOpenCode } from './scan-opencode.js';
import { scanPi } from './scan-pi.js';
import type { BillableSource, ScanWindow, UsageRecord } from './types.js';

/**
 * The usage scanners of the built-in sources, by built-in id. A built-in without one (`grok`) contributes presence
 * only. The hook path never loads this module, so it reaches no scanner.
 */
const BUILTIN_SCANNERS: Record<string, (window: ScanWindow) => Promise<UsageRecord[]>> = {
  codex: scanCodex,
  claude: scanClaude,
  gemini: scanGemini,
  opencode: scanOpenCode,
  pi: scanPi,
  dsh: scanDsh
};

/**
 * The merged-table sources that expose `scanUsage`, in table order — the input
 * to `collectWindowUsage`. A `builtin:` entry scans with its built-in's scanner
 * and a JS `handler` with its own `scanUsage`. `includeHandlers` defaults to
 * `true` (the `usage` command may load a billable JS handler); the
 * signature-badge refresh passes `false` so no third-party module is imported
 * there, scanning only the first-party `builtin:` sources.
 */
export async function billableSources(
  config: AppConfig,
  options: { includeHandlers?: boolean } = {}
): Promise<BillableSource[]> {
  const billable: BillableSource[] = [];
  for (const [id, entry] of Object.entries(mergedSources(config))) {
    const resolved = await resolveSourcePlugin(id, entry, options);
    if (!resolved) {
      continue;
    }
    const { plugin } = resolved;
    const scanUsage = resolved.trusted ? BUILTIN_SCANNERS[plugin.id] : plugin.scanUsage?.bind(plugin);
    if (scanUsage) {
      billable.push({ id, scanUsage });
    }
  }
  return billable;
}
