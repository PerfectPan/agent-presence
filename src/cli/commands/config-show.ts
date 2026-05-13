import { configSlotId, debounceMs, feishuSignatureConfig, getConfigPath, loadConfig, providerId, renderTemplates, ttlMs } from '../../config.js';

export async function printConfig(): Promise<void> {
  const config = await loadConfig();
  console.log(
    JSON.stringify(
      {
        configPath: getConfigPath(),
        provider: providerId(config),
        providerConfig: feishuSignatureConfig(config),
        slotId: configSlotId(config) ?? '',
        ttlMs: ttlMs(config),
        debounceMs: debounceMs(config),
        render: renderTemplates(config)
      },
      null,
      2
    )
  );
}
