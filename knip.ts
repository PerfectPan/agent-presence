import { knip } from '@perfectpan/lint-config/knip';
import type { KnipConfig } from 'knip';

// Everything under src/ and scripts/ ships through `vp pack` (see vite.config.ts pack.entry),
// and src/hooks/*.ts are installed into coding-agent configs that load them dynamically.
const config: KnipConfig = {
  ...knip,
  workspaces: {
    '.': {
      entry: ['src/**/*.ts!', 'scripts/**/*.ts!'],
      project: ['src/**/*.ts!', 'scripts/**/*.ts!']
    },
    site: {
      entry: ['src/pages/**/*.{astro,ts,tsx,mdx}!'],
      project: ['src/**/*.{astro,ts,tsx,mdx}!']
    }
  }
};

export default config;
