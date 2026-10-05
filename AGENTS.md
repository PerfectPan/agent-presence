# Agent Guidelines

This repository is public and publishes `@rivus/agent-presence` to npm. Treat every change as if it may be reviewed, packaged, indexed, and installed by users.

## Working Rules

- Keep changes scoped to the user request and nearby code.
- Prefer existing project patterns over new abstractions.
- Do not commit local config, credentials, generated logs, temporary workspaces, build artifacts, or machine-specific paths.
- Do not add private tokens, internal hostnames, private repository names, or personal filesystem paths.
- Use `rg` for searches when available.
- Update tests and documentation when behavior changes.
- Never run `agent-presence setup`, the `install:*` / `uninstall:*` scripts, or a hook command against your real home directory. Run them with `HOME="$(mktemp -d)"` so the real `~/.agent-presence`, agent configs, Keychain entries, and LaunchAgents stay untouched.

## Collaboration Rules

- Treat user corrections as required scope changes, not as optional follow-up notes. Update the code, docs, workflow files, and pull request description in the same thread when the correction changes the intended behavior or delivery story.
- When continuing an existing branch or pull request, fetch latest refs and rebase onto the current `origin/main` before adding new commits unless the user explicitly asks for a different base.
- If a user says the implementation target is a UI surface, workflow behavior, release artifact, or published package state, update the executable configuration that drives that surface instead of only documenting the intended manual process.
- If current code and docs disagree, update the docs to the current code in the same change unless the user explicitly asks to leave docs untouched.

## Project Commands

```bash
# Install the shared review checks and local Git hooks:
gh extension install PerfectPan/gh-repo-checks
./scripts/install-git-hooks.sh

# Repository checks:
gh repo-checks repository

# PR title check:
gh repo-checks pr-title "docs: update contributing guide"

# PR description check (file or stdin):
gh repo-checks pr-body pr-body.md

# Install, then the CI gates:
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
pnpm pack --dry-run

# CLI smoke check:
node dist/src/cli.js --help

# Docs site:
pnpm -C site run docs:build

# Release check:
pnpm changeset status
```

Do not claim implementation work is complete until the relevant commands pass, or until skipped commands are explained with concrete blockers. For package changes, inspect the `pnpm pack --dry-run` file list.

## Development Workflow

For non-trivial changes, follow the Spec/Plan selection rules in the [Change Design Gate](CONTRIBUTING.md#change-design-gate). Review required design artifacts before implementation. The Spec states required behavior; the Plan records technical decisions and the ordered tasks, tests, and exit conditions to execute. Do not start a Plan that is blocked on an unresolved decision. Migrate lasting constraints to current-state documentation before deleting a completed Spec or Plan.

Read [`docs/architecture.md`](docs/architecture.md) before changing runtime behavior. The constraints that matter most:

- The hook path (`agent-presence hook`) runs inside another agent's lifecycle. It must stay fast, bounded, non-interactive, and fail-open: a hook never throws into or blocks the agent, and Codex hooks always print `{}`.
- Presence comes from lifecycle events, never from process scans. Each agent is a source in the source table: built-ins are `builtin:<id>` entries in `src/sources.default.json` backed by resolvers in `src/cli/hook-context.ts`, and a user's `plugins.sources` config merges over them. A new agent is a new source entry, not a special case in the hook command.
- Token usage is a source capability (`scanUsage`) that reads local transcripts after the fact. Hook payloads carry no usage, except the managed dsh plugin, whose usage lands in a local log that dsh's `scanUsage` reads back.
- Credentials live in Keychain, libsecret, or environment variables, never in config files, hook commands, signature URLs, logs, tests, or changesets.

## Documentation

- Keep `README.md` and `README.zh-CN.md` focused on orientation, quick start, and current user-facing behavior; the user guide lives in `site/`.
- Use `docs/architecture.md` for the current runtime architecture and trust boundaries.
- Use `CONTRIBUTING.md` for contribution workflow.
- Use `docs/specs/` for active product behavior and `docs/plans/` for active technical decisions and detailed execution plans. Current-state documentation owns implemented behavior. See `docs/README.md`.
- Record user-facing changes with a changeset (`pnpm changeset`) in the same PR; do not edit the generated `CHANGELOG.md`.

## AI Delivery Workflow

When an AI agent completes implementation work:

1. Inspect `git status --short --branch`.
2. Verify generated files, secrets, machine paths, and build artifacts are not staged.
3. Run the required verification gates and record the exact commands.
4. Commit pending changes with a concise conventional commit message.
5. Push the branch and verify the remote head.
6. Create or reuse a GitHub Pull Request when the task is not landing directly on `main`.
7. Include a delivery summary with what changed and why, validation, and remaining risks.

## Review Evidence

- PR titles must be English and follow `type(scope): summary`, including bot-generated release and dependency PRs such as `chore(release): version packages`; use `gh repo-checks pr-title` to verify them.
- PR descriptions must have a Summary (what changed and why) and a Validation section (exact commands and results, skipped gates with reasons); add Risks when there are any. Do not add agent attribution lines such as "Generated with <tool>". Verify the body with `gh repo-checks pr-body` before opening or updating the PR. Bot-opened PRs are exempt from the description check, not the title check.
- If a claim depends on logs, screenshots, package output, deployed behavior, or generated artifacts, attach or link the evidence in the PR.
- Update the PR description after substantial code changes, review-driven revisions, rebases that change behavior, or validation reruns.
- After a rebase or force-push, verify the remote branch head, commit signature status, pull request issue links, and CI status before reporting completion.
- Keep the GitHub PR template and the GitLab MR template in sync; `gh repo-checks repository` checks both.

## Git

- Branch names should be short and descriptive, such as `feat/release-source`.
- Commit messages should be concise and use conventional prefixes when they fit.
- Signed commits are preferred when local git signing is configured.
- Do not rewrite or discard user changes unless explicitly requested.

## Publish Safety Check

`gh repo-checks repository` (pre-commit hook and CI) rejects tracked local artifacts, obvious secrets, and personal filesystem paths. Test fixtures use neutral paths such as `/fake-home/...` or `/work/...`. Before pushing public-facing or package-facing changes, also scan for accidental private references:

```bash
rg --hidden --no-ignore -n "private-token|internal-domain.example|HOME_PATH_PLACEHOLDER|bnpm|byted" . \
  --glob '!.git/**' \
  --glob '!node_modules/**' \
  --glob '!**/node_modules/**' \
  --glob '!dist/**' \
  --glob '!pnpm-lock.yaml' \
  --glob '!AGENTS.md' \
  --glob '!CONTRIBUTING.md' \
  --glob '!SECURITY.md'
```
