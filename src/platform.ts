const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin']);

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (!isSupportedPlatform(platform)) {
    throw new Error(`agent-presence currently supports macOS only; detected ${platform}`);
  }
}
