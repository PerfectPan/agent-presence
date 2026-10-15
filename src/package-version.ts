import { readFileSync } from 'node:fs';
import * as z from 'zod/mini';

const packageSchema = z.object({
  name: z.literal('@rivus/agent-presence'),
  version: z.string().check(z.minLength(1))
});

export function packageVersion(): string {
  for (const url of [new URL('../package.json', import.meta.url), new URL('../../package.json', import.meta.url)]) {
    try {
      return packageSchema.parse(JSON.parse(readFileSync(url, 'utf8'))).version;
    } catch {
      // Source and dist builds resolve package.json from different depths.
    }
  }
  throw new Error('unable to resolve @rivus/agent-presence package version');
}
