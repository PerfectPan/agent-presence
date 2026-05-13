import {
  feishuSignatureConfig,
  getConfigPath,
  loadConfig,
  providerId,
  saveConfig,
  type AppConfig,
  type FeishuSignatureProviderConfig
} from '../../config.js';
import { hasAnyOption, hasFlag, optionValue } from '../args.js';
import { isInteractiveTerminal, promptText } from '../ui.js';

const PROVIDER_OPTIONS = ['--base-url', '--preview-base-url', '--image-key', '--target-url'];

export async function configureProvider(args: string[]): Promise<void> {
  const config = await loadConfig();
  const explicitProvider = args[0]?.startsWith('--') ? optionValue(args, '--provider') : (args[0] ?? optionValue(args, '--provider'));
  const targetProvider = providerId(config, explicitProvider);
  const reset = hasFlag(args, '--reset');
  const providers = { ...(config.providers ?? {}) };
  const nextConfig: AppConfig = { ...config, provider: targetProvider, providers };
  const nextProviderConfig = reset ? {} : { ...(config.providers?.[targetProvider] ?? {}) };

  if (!reset && isInteractiveTerminal() && !hasAnyOption(args, PROVIDER_OPTIONS)) {
    await promptProviderConfig(nextProviderConfig, feishuSignatureConfig(config));
  } else {
    setOptionalValue(nextProviderConfig, 'baseUrl', optionValue(args, '--base-url'));
    setOptionalValue(nextProviderConfig, 'previewBaseUrl', optionValue(args, '--preview-base-url'));
    setOptionalValue(nextProviderConfig, 'previewImageKey', optionValue(args, '--image-key'));
    setOptionalValue(nextProviderConfig, 'previewTargetUrl', optionValue(args, '--target-url'));
  }

  if (Object.keys(nextProviderConfig).length > 0) {
    providers[targetProvider] = nextProviderConfig;
  } else {
    delete providers[targetProvider];
    if (Object.keys(providers).length === 0) {
      delete nextConfig.providers;
    }
  }

  await saveConfig(nextConfig, getConfigPath());
  console.log(
    JSON.stringify(
      {
        status: 'updated',
        provider: targetProvider,
        providerConfig: feishuSignatureConfig(nextConfig)
      },
      null,
      2
    )
  );
}

async function promptProviderConfig(target: Record<string, string>, current: FeishuSignatureProviderConfig): Promise<void> {
  setOptionalValue(
    target,
    'baseUrl',
    await promptOptionalText('Slot API base URL', current.baseUrl ?? 'https://l.garyyang.work')
  );
  setOptionalValue(
    target,
    'previewBaseUrl',
    await promptOptionalText('Signature preview base URL', current.previewBaseUrl ?? 'https://l.garyyang.work/')
  );
  setOptionalValue(target, 'previewImageKey', await promptOptionalText('Preview image key', current.previewImageKey));
  setOptionalValue(target, 'previewTargetUrl', await promptOptionalText('Preview target URL', current.previewTargetUrl));
}

async function promptOptionalText(message: string, initialValue?: string): Promise<string | undefined> {
  const value = await promptText({
    message,
    initialValue,
    placeholder: initialValue
  });
  return value.trim() || undefined;
}

function setOptionalValue(target: Record<string, string>, key: string, value: string | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
