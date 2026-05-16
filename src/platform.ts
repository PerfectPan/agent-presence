const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux']);

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (!isSupportedPlatform(platform)) {
    throw new Error(`agent-presence currently supports macOS and Linux; detected ${platform}`);
  }
}

export function isMacOS(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

export function assertMacOS(platform: NodeJS.Platform = process.platform): void {
  if (!isMacOS(platform)) {
    throw new Error(`agent-presence power watcher requires macOS; detected ${platform}`);
  }
}
