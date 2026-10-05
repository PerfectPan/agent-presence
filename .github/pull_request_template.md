Title format: `type(scope): summary`, in English.

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

## Summary

<!-- What changed and why. Link the issue, Spec, or Plan when there is one. -->

-

## Validation

<!-- Commands you ran and their results; logs or screenshots for behavior claims. Name skipped checks and why. -->

- [ ] Repository checks: `gh repo-checks repository`
- [ ] PR title and description: `gh repo-checks pr-title "<title>"`, `gh repo-checks pr-body <body-file>`
- [ ] Install: `pnpm install --frozen-lockfile`
- [ ] Test: `pnpm test`
- [ ] Typecheck: `pnpm run typecheck`
- [ ] Build: `pnpm run build`
- [ ] Docs site, when `site/` changes: `pnpm -C site run docs:build`
- [ ] Changeset: `pnpm changeset status` (user-facing package changes add a changeset)
- [ ] Package dry-run: `pnpm pack --dry-run`

## Risks

<!-- Optional: compatibility, rollout, rollback, or follow-up risks. Delete this section when there are none. -->

-
