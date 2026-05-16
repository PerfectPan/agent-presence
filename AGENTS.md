# Agent Guidelines

This repository is intended to become a maintainable, publishable project. Treat every change as if it may be reviewed, packaged, indexed, and installed by users.

## Working Rules

- Keep changes scoped to the user request and nearby code.
- Prefer existing project patterns over new abstractions.
- Do not commit local config, credentials, generated logs, temporary workspaces, build artifacts, or machine-specific paths.
- Do not add private tokens, internal hostnames, private repository names, or personal filesystem paths.
- Use `rg` for searches when available.
- Update tests and documentation when behavior changes.

## Collaboration Rules

- Treat user corrections as required scope changes, not as optional follow-up notes. Update the code, docs, workflow files, and pull request description in the same thread when the correction changes the intended behavior or delivery story.
- When continuing an existing branch or pull request, fetch latest refs and rebase onto the current `origin/main` before adding new commits unless the user explicitly asks for a different base.
- After a rebase or force-push, verify the remote branch head, commit signature status, pull request issue links, and CI status before reporting completion.
- Keep the PR body current after every meaningful change. Its summary, validation, and follow-up risks should match the branch that is actually pushed.
- If a user says the implementation target is a UI surface, workflow behavior, release artifact, or published package state, update the executable configuration that drives that surface instead of only documenting the intended manual process.
- If current code and docs disagree, update the docs to the current code in the same change unless the user explicitly asks to leave docs untouched.

## Project-Specific Commands

```bash
pnpm install --frozen-lockfile --ignore-scripts

pnpm test

pnpm run typecheck

pnpm run build

pnpm pack --dry-run

rg --hidden --no-ignore -n "private-token|internal-domain.example|HOME_PATH_PLACEHOLDER|bnpm|byted" . \
  --glob '!.git/**' \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  --glob '!pnpm-lock.yaml' \
  --glob '!AGENTS.md' \
  --glob '!CONTRIBUTING.md' \
  --glob '!SECURITY.md'
```

Do not claim implementation work is complete until the relevant commands pass, or until skipped commands are explained with concrete blockers.

## Documentation

- Keep `README.md` focused on orientation, quick start, and current user-facing behavior.
- Use `docs/architecture.md` for the current runtime architecture and trust boundaries.
- Use `CONTRIBUTING.md` for contribution workflow.
- Use `rfcs/` for substantial design proposals.
- Update `CHANGELOG.md` for user-facing changes unless the change is docs-only or repository-only.

## AI Delivery Workflow

When an AI agent completes implementation work:

1. Inspect `git status --short --branch`.
2. Verify generated files, secrets, machine paths, and build artifacts are not staged.
3. Run the required verification gates and record the exact commands.
4. Commit pending changes with a concise conventional commit message.
5. Push the branch and verify the remote head.
6. Create or reuse a GitHub Pull Request when the task is not landing directly on `main`.
7. Include a delivery summary with motivation, implementation notes, validation, and follow-up risks.

## Git

- Branch names should be short and descriptive, such as `feat/release-source`.
- Commit messages should be concise and use conventional prefixes when they fit.
- Signed commits are preferred when local git signing is configured.
- Do not rewrite or discard user changes unless explicitly requested.

## Publish Safety Check

Before pushing public-facing or package-facing changes, scan for accidental private references. Adjust globs for the project stack:

Use the project-specific hygiene scan above before public PRs and releases.
