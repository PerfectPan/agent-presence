import type { AppConfig } from '../config.js';
import { mergedSources, resolveSourcePlugin } from '../sources.js';
import { KIT_AGENT_BY_SOURCE } from './kit.js';
import { scanDsh } from './scan-dsh.js';
import type { BillableSource } from './types.js';

/**
 * The merged-table sources that contribute usage, in table order — the input
 * to `collectWindowUsage`. A `builtin:` entry with a kit decoder is marked with
 * its kit agent id (`KIT_AGENT_BY_SOURCE`) for the batched window scan; dsh
 * keeps its own log reader and a JS `handler` its own `scanUsage`.
 * `includeHandlers` defaults to `true` (the `usage` command may load a billable
 * JS handler); the signature-badge refresh passes `false` so no third-party
 * module is imported there, scanning only the first-party `builtin:` sources.
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
    const { plugin, trusted } = resolved;
    if (trusted) {
      const kitAgent = KIT_AGENT_BY_SOURCE[plugin.id];
      if (kitAgent !== undefined) {
        billable.push({ id, kitAgent });
      } else if (plugin.id === 'dsh') {
        billable.push({ id, scanUsage: scanDsh });
      }
      continue;
    }
    const scanUsage = plugin.scanUsage?.bind(plugin);
    if (scanUsage) {
      billable.push({ id, scanUsage });
    }
  }
  return billable;
}
