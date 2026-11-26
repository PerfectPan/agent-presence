<!-- Title format: `type(scope): summary`, in English. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. -->

## Summary

<!-- What changed and why. Link the issue or Plan when there is one. -->

-

## Validation

<!-- Commands you ran and their results; logs or screenshots for behavior claims. Name skipped checks and why. -->

- [ ] Repository checks: `gh repo-checks repository`
- [ ] MR title and description: `gh repo-checks pr-title "<title>"`, `gh repo-checks pr-body <body-file>`
- [ ] Install: `pnpm install --frozen-lockfile`
- [ ] Format: `pnpm format:check`
- [ ] Test: `pnpm test`
- [ ] Typecheck: `pnpm run typecheck`
- [ ] Lint: `pnpm lint` (after `pnpm -C site run docs:sync` in a fresh checkout)
- [ ] Run `pnpm knip` and `pnpm knip:production`. Unused files, exports, dependencies, or configuration and tag hints fail CI.
- [ ] Duplicate code: `pnpm duplicates` (fails on any reported clone, while `pnpm duplicates:audit` only reports findings)
- [ ] Build: `pnpm run build`
- [ ] Docs site, when `site/` changes: `pnpm -C site run docs:build`
- [ ] Changeset: `pnpm changeset status` (user-facing package changes add a changeset)
- [ ] Package dry-run: `pnpm pack --dry-run`

## Risks

<!-- Optional: compatibility, rollout, rollback, or follow-up risks. Delete this section when there are none. -->

-
