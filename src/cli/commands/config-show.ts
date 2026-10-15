import {
  configSlotId,
  debounceMs,
  feishuSignatureConfig,
  getConfigPath,
  providerId,
  renderTemplates,
  ttlMs
} from '../../config.js';
import { loadValidatedConfig } from '../../config-schema.js';
import { describeSources } from '../../sources.js';

export async function printConfig(): Promise<void> {
  const { config, issues } = await loadValidatedConfig();
  console.log(
    JSON.stringify(
      {
        configPath: getConfigPath(),
        provider: providerId(config),
        providerConfig: feishuSignatureConfig(config),
        slotId: configSlotId(config) ?? '',
        ttlMs: ttlMs(config),
        debounceMs: debounceMs(config),
        render: renderTemplates(config),
        sources: describeSources(config),
        // The dropped values the load reported; the key stays out for a valid config, so valid output is unchanged.
        ...(issues.length > 0 ? { configIssues: issues } : {})
      },
      null,
      2
    )
  );
}
