# Changesets

This repository uses Changesets for versioning and npm releases.

Add a changeset for user-facing changes:

```bash
pnpm run changeset
```

Merging to `main` runs `.github/workflows/publish.yml`. When changesets exist, it opens or updates a Version Packages pull request. Merging that release pull request publishes through npm Trusted Publishing with pnpm and the checked-in lockfile.
