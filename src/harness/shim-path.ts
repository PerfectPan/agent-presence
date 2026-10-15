import { join } from 'node:path';
import { getHomeDir } from '../config.js';

export function presenceShimPath(home = getHomeDir()): string {
  return join(home, 'bin', 'agent-presence');
}
