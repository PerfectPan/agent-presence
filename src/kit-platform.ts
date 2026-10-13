import { createNodePlatform } from '@rivus/agent-kit/node';
import type { Platform } from '@rivus/agent-kit/platform';

let platform: Platform | undefined;

/**
 * The kit's Node platform for this process: created on the first call, then shared by every caller, so importing this
 * module costs nothing until a lock or another kit use case needs it. Its `env` and `home` are snapshots taken by
 * that first call; code that needs other values creates its own platform.
 */
export function kitPlatform(): Platform {
  platform ??= createNodePlatform();
  return platform;
}
