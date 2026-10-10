import { chmodSync, globSync } from 'node:fs';
import { fmt, lint } from '@perfectpan/lint-config/vite-plus';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ...fmt,
    // Keep the quote style the existing code uses.
    singleQuote: true,
    ignorePatterns: [
      // Copied verbatim from the project template; keep them byte-identical so syncs stay a plain diff.
      '.github/ISSUE_TEMPLATE/**',
      '.github/workflows/review.yml',
      'docs/specs/0000-template.md',
      'docs/specs/README.md',
      'docs/plans/0000-template.md',
      'docs/plans/README.md',
      // Generated: Changesets writes the changelog, `pnpm run update-pricing` the price snapshot.
      'CHANGELOG.md',
      'src/usage/litellm-pricing.json'
    ]
  },
  lint: {
    ...lint,
    ignorePatterns: ['dist/**', 'site/dist/**', 'site/.astro/**']
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  },
  pack: {
    // Modules locate shipped files from import.meta.url: sources.default.json, litellm-pricing.json,
    // ../scripts/<name>, and cli.js. One output file per source file keeps those URLs on the paths
    // already-installed hooks call (`dist/src/cli.js`).
    entry: ['src/**/*.ts', 'scripts/**/*.ts'],
    unbundle: true,
    root: '.',
    format: 'esm',
    platform: 'node',
    // `platform: 'node'` would emit `.mjs`, and the default hash would rename chunks.
    fixedExtension: false,
    hash: false,
    // Transpile each module. Tree-shaking would drop statements that nothing imports.
    treeshake: false,
    sourcemap: true,
    // Oxc's declaration generator requires isolatedDeclarations, which this source does not enable.
    // TypeScript 7 is installed, so tsdown's tsgo generator emits the .d.ts files.
    dts: { generator: 'tsgo' },
    // Do not rewrite package.json `bin` or `exports`. The two JSON files are not modules.
    exports: false,
    copy: [
      { from: 'src/sources.default.json', to: 'dist/src' },
      { from: 'src/usage/litellm-pricing.json', to: 'dist/src/usage' }
    ],
    onSuccess() {
      chmodSync('dist/src/cli.js', 0o755);
      for (const file of globSync('dist/scripts/*.js')) {
        chmodSync(file, 0o755);
      }
    }
  }
});
