import type { ProviderId } from '../config.js';
import { LGaryYangProvider } from './l-garyyang.js';
import type { PresenceProvider, ProviderOptions } from './types.js';

export type ProviderFactory = (options: ProviderOptions) => PresenceProvider;

const factories: Record<ProviderId, ProviderFactory> = {
  'feishu-signature': ({ baseUrl, credential }) => new LGaryYangProvider(baseUrl, credential)
};

export function createProvider(id: ProviderId, options: ProviderOptions): PresenceProvider {
  const factory = factories[id];
  if (!factory) {
    throw new Error(`unsupported provider: ${id}`);
  }
  return factory(options);
}

export function registeredProviderIds(): ProviderId[] {
  return Object.keys(factories) as ProviderId[];
}
