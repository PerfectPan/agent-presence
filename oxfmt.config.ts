import { fmt } from '@perfectpan/lint-config/vite-plus';

export default {
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
};
