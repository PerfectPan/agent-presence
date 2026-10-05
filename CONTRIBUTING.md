# Contributing

## Development Setup

```bash
corepack enable
pnpm install --frozen-lockfile
gh extension install PerfectPan/gh-repo-checks
./scripts/install-git-hooks.sh
pnpm test
pnpm run typecheck
pnpm run build
node dist/src/cli.js --help
```

Use the Node.js major in `.node-version` (the current Active LTS line; CI reads the same file) and the pnpm version pinned in `packageManager` (pnpm 12). pnpm runs dependency build scripts only for packages listed in `allowBuilds` in `pnpm-workspace.yaml`; when an install fails with `ERR_PNPM_IGNORED_BUILDS`, add the package there with `true` or `false` and a comment saying why. The same file keeps `minimumReleaseAge: 1440` and the other supply-chain settings explicit. If an install fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, pick an older version instead of lowering the setting. `site/` is a project of the root workspace and shares its lockfile and settings.

The installer scripts (`pnpm run install:*` / `uninstall:*`) and `agent-presence setup` write to the real agent configs, Keychain, and LaunchAgents under your home directory. When trying them from a checkout, run them with `HOME="$(mktemp -d)"` unless you mean to change your own setup.

## Contribution Flow

1. Open an issue or discussion for ambiguous work.
2. Choose Spec and Plan artifacts using the [Change Design Gate](#change-design-gate) before substantial work, and review the behavior and technical design before implementing that scope.
3. Create a focused branch.
4. Install local Git hooks with `./scripts/install-git-hooks.sh` if this checkout has not already done so.
5. Add or update tests for behavior changes.
6. Add a changeset for user-facing package changes.
7. Run the [Required Checks](#required-checks).
8. Update `README.md`, `README.zh-CN.md`, `docs/`, `site/`, or the active Spec and Plan when user-facing behavior, architecture, workflow, or operations change.
9. Open a pull request with a conventional title, a summary of what changed and why, validation with skipped gates, and any risks.
10. Keep the PR description current after review feedback, rebases, validation reruns, or scope changes.

Small fixes, typo corrections, dependency metadata updates, and narrow documentation improvements do not need a separate Spec and Plan.

## Required Checks

CI (`.github/workflows/ci.yml` and `.github/workflows/review.yml`) runs these on every pull request; run them locally before opening review:

```bash
# Repository checks:
gh repo-checks repository

# PR title and description:
gh repo-checks pr-title "docs: update contributing guide"
gh repo-checks pr-body pr-body.md

# Install and CI gates:
pnpm install --frozen-lockfile
pnpm format:check
pnpm test
pnpm run typecheck
pnpm lint
pnpm run build
pnpm pack --dry-run
```

`pnpm format` applies the formatting. `pnpm lint` is type-aware and also checks the docs site, whose modules import `astro:content`; in a fresh checkout, generate those types first with `pnpm -C site run docs:sync` (a site build also does it).

### Lint, Format, And TypeScript Config

Shared rules come from [`@perfectpan/lint-config`](https://github.com/PerfectPan/lint-config), installed as a git dependency pinned to a tag. This repository keeps only its own settings:

- `.oxlintrc.json` extends the shared oxlint config (type-aware, warnings fail, `curly: all`, kebab-case file names, at most 1000 lines per non-test file) and ignores build output. It lints the docs site's scripts and `.astro` frontmatter too.
- `oxfmt.config.ts` spreads the shared oxfmt options and keeps single quotes, the style the existing code used. It skips the files copied verbatim from the project template and the generated `CHANGELOG.md` and `src/usage/litellm-pricing.json`.
- `tsconfig.json` extends the shared `node` tsconfig (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) and adds only `types`, the output settings, and `include`; `tsconfig.build.json` narrows `include` for the build.

Upgrade the shared rules by bumping the tag in `package.json`, then fix or explicitly override what the new release reports.

When a change touches `site/`, also build the docs site with `pnpm -C site run docs:build`. For package-facing changes, run `pnpm changeset status` and inspect the `pnpm pack --dry-run` file list.

## Changesets

Use Changesets for the package version and changelog entries:

```bash
pnpm run changeset
```

Choose `patch`, `minor`, or `major` according to the impact on users of the published CLI. Documentation-only changes, repository metadata changes, tests, and internal maintenance that do not affect the published package can skip a changeset.

Only the published package gets changesets. The private docs site package (`site/`) is not versioned or tagged (`privatePackages` in [`.changeset/config.json`](.changeset/config.json)). Changelog entries link the pull request and author through `@changesets/changelog-github`, which reads them from the GitHub API, so `changeset version` needs a `GITHUB_TOKEN`.

### Releasing

The package is published as `@rivus/agent-presence` through Changesets and npm Trusted Publishing (OIDC); the release workflow carries no long-lived npm write token.

1. Merge feature PRs that include `.changeset/*.md` files.
2. `.github/workflows/publish.yml` opens or updates a `chore: release package` PR.
3. Review and merge that release PR.
4. `changesets/action` publishes to npm via Trusted Publishing and then creates the matching GitHub Release.

Two settings surfaces must stay in sync:

- **GitHub**: `PerfectPan/agent-presence` → Settings → Actions → General: allow read/write workflow permissions and let GitHub Actions create and approve pull requests, so the Changesets action can open the release PR.
- **npm**: `npmjs.com` → Packages → `@rivus/agent-presence` → Settings → Trusted publishing, using owner `PerfectPan`, repository `agent-presence`, workflow filename `publish.yml`. Renaming the workflow file breaks publishing until this setting changes too.

Trusted Publishing cannot be configured until the package exists on npm. To bootstrap a brand-new package, run one explicit publish with a short-lived granular npm token (outside the normal workflow), confirm the package exists, configure Trusted Publishing as above, then revoke the token and remove any temporary workflow changes.

### Pricing Snapshot

`src/usage/litellm-pricing.json` is generated, not hand-edited. `pnpm run update-pricing` regenerates it from LiteLLM for the supported model allowlist in `scripts/update-pricing.mjs`; add a model id to that allowlist when a source starts recording it. `.github/workflows/update-pricing.yml` runs the same script weekly and opens the PR `chore(usage): update LiteLLM pricing snapshot` when prices drift.

## SDD Workflow And Document Lifecycle

1. Record the problem, affected users or maintainers, in-scope behavior, non-goals, and acceptance conditions.
2. Choose artifacts with the [Change Design Gate](#change-design-gate). Product work defaults to one behavioral Spec and one detailed Plan for the same deliverable. The Spec states required behavior: interactions and acceptance scenarios. The Plan owns the technical decisions (design, component and interface changes, data flow) and the detailed execution plan (ordered tasks, tests, exit conditions, validation, and rollback).
3. Review the behavior and technical design before implementing the affected scope. The Plan must resolve implementation decisions rather than leave them to the implementer; keep it blocked while a material decision is unresolved. New behavior revises the Spec. New implementation decisions revise the Plan.
4. Implement inside that boundary. Add evidence for each acceptance condition, or say why existing evidence is enough. Update current-state docs in the same change.
5. Before retiring a completed Spec or Plan, move still-valid behavior, invariants, and operational limits into current-state docs and tests. The final delivery PR may delete the completed files. Keep an unfinished Spec or Plan active.
6. Git history and the delivery PR keep the retired decision. Do not copy completed Specs or Plans into a second archive.

## Change Design Gate

Every change needs a requirement record. Use the smallest set of artifacts that makes behavior and implementation reviewable.

| Change type                                      | Required artifact                                              |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Product behavior                                 | One Spec plus one detailed Plan for the same deliverable       |
| Technical refactor without changed user behavior | Detailed Plan with compatibility and acceptance conditions     |
| Narrow maintenance, tests, or documentation      | Requirement and PR checklist; a separate Plan only when useful |

In this repository, changes to public CLI behavior, hook or installer behavior, install, deploy, or rollback safety, trust boundaries, configuration shape, the release process, repository structure, and long-term integration strategy count as product behavior or technical refactors, not narrow maintenance.

A Spec defines observable interactions, scope, failure behavior, and acceptance examples. Use stable scenario IDs and Given/When/Then where useful. Link scenarios to tests. A Spec does not prescribe components, interfaces, or execution order. Keep active Specs under [`docs/specs/`](docs/specs/). A small change may keep both sections in the PR description. Split only when each slice has an independently demonstrable outcome.

A Plan records technical decisions and the detailed execution plan that implements them. Shared architecture, compatibility, security, and recovery decisions belong in a reviewed Plan. After implementation, move lasting constraints into current-state architecture or operations docs. This repository does not keep an RFC directory; the RFCs it used earlier are retired into [`docs/architecture.md`](docs/architecture.md) and the active Specs and Plans, and remain in Git history. Removing a proposal does not mark unimplemented ideas as delivered.

Number a Spec and its paired Plan with the same four-digit id; new work takes the next free number across both directories.

## Implementation Plans

[`docs/plans/`](docs/plans/) contains active Plans: technical decisions plus a detailed execution plan. Copy [`0000-template.md`](docs/plans/0000-template.md) and keep only the sections that apply. A product plan links its paired Spec. Explain the current constraints, the decisions, the boundaries, the failure and rollback behavior, and how the change will be verified. A file list alone is not a design.

The execution plan tells the implementer exactly what to do: preconditions, a completion contract, ordered tasks with files, changes, tests, and exit conditions, a validation ledger, and rollback per batch. Keep the plan blocked while a decision that changes scope, interfaces, data, or rollout is unresolved.

Keep unknown owners, dates, and interfaces marked "unconfirmed". A plan may make feature-specific technical decisions, but it cannot silently override current architecture. At completion, migrate lasting constraints into current-state docs and tests, then delete the completed Spec and plan in the final delivery PR. Keep unfinished scope visible.

## Documentation Standards

- Use `README.md` and `README.zh-CN.md` for orientation, quick start, and current user-facing behavior.
- Use `CONTRIBUTING.md` for contribution workflow, review expectations, and repository policy.
- Use `AGENTS.md` for AI-agent instructions.
- Use `docs/specs/` for active product behavior and acceptance contracts.
- Use `docs/plans/` for active technical decisions and detailed execution plans.
- Use `docs/architecture.md` for the current runtime architecture and trust boundaries, and the Astro site under `site/` for the user guide.

Follow [`docs/README.md`](docs/README.md) when adding or reorganizing documentation.

## Pull Request Expectations

The PR template has three sections:

- **Summary**: what changed and why, with links to the issue, Spec, or Plan.
- **Validation**: the commands you ran and their results, evidence for behavior or packaging claims, and skipped gates with reasons.
- **Risks** (optional): compatibility, rollout, rollback, or follow-up risks. Delete it when there are none.

Use a conventional title:

```text
type(scope): summary
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Titles are English; `gh repo-checks pr-title` rejects CJK characters. Bot-generated PRs follow the same rule: the pricing snapshot PR uses `chore(usage): update LiteLLM pricing snapshot`, and dependency bots should emit titles such as `chore(deps): bump <package> to <version>`.

Summary and Validation from the [PR template](.github/pull_request_template.md) must be present and contain real content, not template placeholders; other sections are optional. Do not include agent attribution lines such as "Generated with <tool>"; the author is accountable for the content. `gh repo-checks pr-body` enforces these rules, and the `PR description` job runs it on every pull request event, including description edits. PRs opened by bot accounts skip the description check, because dependency and release bots write their own bodies; they still must pass the title check. A skipped job still satisfies the required status check.

Update the description when review feedback, rebases, or follow-up commits change the scope or validation result. Reviewers should be able to understand the final state from the PR without reconstructing it from comments.

## License

Tools and libraries use MIT; applications use GPL-3.0-only. `@rivus/agent-presence` is a CLI, so the repository and the package are MIT (`LICENSE`, `license` in `package.json`). Change it only as a deliberate project decision, and keep third-party notices for code or data copied from other projects.

## Repository Checks

Do not commit private tokens, local config, generated workspaces, internal hostnames, or personal filesystem paths. Test fixtures use neutral paths such as `/fake-home/...` or `/work/...`, and fixture files avoid ignored extensions such as `.log`.

Keep package and deploy contents intentional. If a file should ship to npm, it must be included through `package.json#files`; verify it appears in the `pnpm pack --dry-run` output.

Use the pinned pnpm version from `packageManager`. Do not commit `package-lock.json`, local `.npmrc` credentials, generated `dist/`, or `node_modules/`.

The review checks come from [`PerfectPan/gh-repo-checks`](https://github.com/PerfectPan/gh-repo-checks): CI runs them through its GitHub Action (`uses: PerfectPan/gh-repo-checks@v1`), and locally they run as a GitHub CLI extension (`gh extension install PerfectPan/gh-repo-checks`). Do not copy the check scripts into this repository; change them upstream. Repository-specific additions, such as extra required files or forbidden patterns, go in [`.github/repo-checks.conf`](.github/repo-checks.conf), and repository-specific scripts run as extra steps after the shared check. `.github/workflows/review.yml`, `.githooks/pre-commit`, `.github/repo-checks.conf`, the issue templates and `scripts/install-git-hooks.sh` are copied verbatim from the shared project template; change them upstream so later syncs stay a plain diff.

Run `gh repo-checks repository` locally before opening review. It does not replace the pnpm gates, but it catches missing template files, tracked local artifacts, obvious secrets, private paths, and drift between the GitHub PR and GitLab MR templates.

Workflows reference actions by their latest major version tag, such as `actions/checkout@v7`, not by commit SHA. The runtime follows the current Node.js Active LTS major in `.node-version`, and moves to the next LTS line in one change when it starts. Workflow files copied from the project template take action upgrades from the template rather than local edits.

## Local Git Hooks

Install local hooks after cloning:

```bash
gh extension install PerfectPan/gh-repo-checks
./scripts/install-git-hooks.sh
```

The pre-commit hook runs `git diff --cached --check` and `gh repo-checks repository --staged` before a commit is created; without the extension it warns and skips the repository check. Hooks are a local guardrail; CI and branch protection remain the authoritative enforcement because hooks can be missing or bypassed.

If `core.hooksPath` is already set to another path, `scripts/install-git-hooks.sh` fails instead of overwriting it. Re-run with `--force` only after confirming the existing hooks can be replaced or moved into `.githooks`.

## Repository Setup

`main` is covered by the repository ruleset `Default`, which blocks deletion and force pushes. Required review checks are not configured yet. Preview the template's protection payload for this repository with:

```bash
gh repo-checks protect --repo PerfectPan/agent-presence --approvals 0 --check "test (ubuntu-latest)" --check "test (macos-latest)"
```

It requires pull requests, linear history, resolved conversations, and the `Review` workflow checks `repository checks`, `conventional PR title`, and `PR description`, plus the CI test jobs. `--approvals 0` fits a single maintainer, who cannot approve their own pull requests. Because the repository already uses a ruleset, add these checks to the `Default` ruleset in the repository settings instead of applying classic branch protection with `--apply`.

The Task issue template applies the `task` label, which GitHub does not create by default. Create it once:

```bash
gh label create task --repo PerfectPan/agent-presence --color 0E8A16 --description "Maintenance, refactoring, dependency, or tooling work"
```

## Security Reports

Use [`SECURITY.md`](SECURITY.md) for vulnerability reporting guidance. Do not include secrets, exploit details, or private infrastructure in public issues or pull requests.
