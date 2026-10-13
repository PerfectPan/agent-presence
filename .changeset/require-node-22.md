---
'@rivus/agent-presence': minor
---

Require Node.js 22.13 or newer. `@rivus/agent-kit`, which the hook command now uses, requires 22.13, and from 22.13 the built-in `node:sqlite` module loads without the `--experimental-sqlite` flag. Node.js 20 is end of life and no longer supported. The package also stops declaring a pnpm version in `engines`, which only applied to developing the repository.
