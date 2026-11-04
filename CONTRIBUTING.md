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

Use the Node.js major in `.node-version` (the current Active LTS line; CI reads the same file) and the pnpm version pinned in `packageManager` (pnpm 12). pnpm runs dependency build scripts only for packages listed in `allowBuilds` in `pnpm-workspace.yaml`; when an install fails with `ERR_PNPM_IGNORED_BUILDS`, add the package there with `true` or `false` and a comment saying why. The same file keeps `minimumReleaseAge: 1440` and the other supply-chain settings explicit. If an install fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, pick an older version instead of lowering the setting. The exclusions are `@rivus/agent-kit` and `@rivus/agent-kit-collab` in `minimumReleaseAgeExclude`: they are the owner's own packages, adopted the day they are released, and the age floor itself stays 1440. `site/` is a project of the root workspace and shares its lockfile and settings.

The installer scripts (`pnpm run install:*` / `uninstall:*`) and `agent-presence setup` write to the real agent configs, Keychain, and LaunchAgents under your home directory. When trying them from a checkout, run them with `HOME="$(mktemp -d)"` unless you mean to change your own setup. The credential integration tests in `test/secret.integration.test.ts` follow the same rule: the macOS case runs against a temporary keychain file the test creates and deletes, and the Linux libsecret case — which writes to the real keyring under a unique service name — runs only when `PRESENCE_SECRET_INTEGRATION=1` is set.

`pnpm test` isolates itself: the Vitest setup file `test/isolated-home-setup.ts` gives every test file its own temporary `HOME` and XDG base directories, and clears your presence, agent, dsh, and provider overrides (`AGENT_PRESENCE_*`, `CODEX_HOME`, `DSH_AGENT_PRESENCE_PLUGIN_FILE`, `MAGIC_BASE_URL`, and the like), so a run leaves your `~/.agent-presence`, agent homes, dsh plugin, and the kit's harness ledger alone and reaches none of your endpoints or credentials. `test/isolated-home.ts` lists what is cleared and the few variables kept on purpose; a test in `test/isolated-home.test.ts` fails when code under `src/` reads a variable neither list covers. A test that needs a particular home or override sets its own.

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

Full CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on Ready PRs when they are opened, receive new commits (`synchronize`), are reopened, or move from Draft to Ready. The Ubuntu and macOS test jobs skip Draft PR events, so keep work in Draft until local checks are finished. A skipped job is reported as successful by GitHub but does not prove that tests ran; before merging, verify that both platform jobs actually ran and passed for the current PR head and merge result.

The separate, lightweight Review workflow (`.github/workflows/review.yml`) still checks repository conventions, PR titles, and descriptions while a PR is Draft, including metadata edits. It does not install the project dependencies or run the full test suite. These early checks remain useful while full CI waits for Ready. Run the following checks locally before marking a PR Ready:

```bash
# Repository checks:
gh repo-checks repository

# PR title and description:
gh repo-checks pr-title "docs: update contributing guide"
gh repo-checks pr-body pr-body.md

# Install and CI gates:
pnpm install --frozen-lockfile
pnpm peers check --lockfile-only
pnpm format:check
pnpm test
pnpm run typecheck
pnpm lint
pnpm run build
pnpm pack --dry-run
```

`pnpm format` applies the formatting. `pnpm lint` is type-aware and also checks the docs site, whose modules import `astro:content`; in a fresh checkout, generate those types first with `pnpm -C site run docs:sync` (a site build also does it).

### Test Placement

Put unit tests beside the module they test (`foo.test.ts` beside `foo.ts`). Keep tests of collaboration between
modules, built artifacts, real child processes, HTTP, SQLite, Keychain, or LaunchAgents in `test/`, with shared
fixtures under `test/fixtures/`. Split mixed files by the contract each case verifies; do not replace real
boundaries with mocks just to move a test beside its source.

Temporary files alone do not make a test an integration test. A reader, writer, or installer can test its own
file contract in isolation. In-memory aggregation and injected fetch/runner contracts also remain unit tests.
Command-to-state/provider flows, transcript ingestion through the usage scanner, and assertions about a
provider's persisted logs exercise collaborating modules and stay in `test/`.

`pnpm test` discovers both `src/**/*.test.ts` and `test/**/*.test.ts`; both use the same per-file HOME isolation.
The build excludes colocated tests, and source-boundary checks inspect production files only. After changing
test placement, run the required checks and inspect `pnpm pack --dry-run` to ensure no tests or fixtures ship.

### Lint, Format, And TypeScript Config

Shared rules come from [`@perfectpan/lint-config`](https://github.com/PerfectPan/lint-config), installed as a git dependency pinned to a tag. This repository keeps only its own settings:

- The `lint` block in `vite.config.ts` spreads the shared oxlint config (type-aware, warnings fail, `curly: all`, kebab-case file names, at most 1000 lines per non-test file) and ignores build output. It lints the docs site's scripts and `.astro` frontmatter too. `pnpm lint` runs it through Vite+ (`vp lint`).
- The `fmt` block in `vite.config.ts` spreads the shared oxfmt options and keeps single quotes, the style the existing code used. It skips the files copied verbatim from the project template and the generated `CHANGELOG.md`. `pnpm format` runs it through Vite+ (`vp fmt`).
- `tsconfig.json` extends the shared `node` tsconfig (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) and adds only `types`, `declaration`, and `include`. `pnpm run typecheck` is `tsc -p tsconfig.json --noEmit`; `declaration` makes it also report the errors that would break the `.d.ts` files the build emits. The output settings live in the `pack` block of `vite.config.ts`. `pnpm run build` is `vp pack`: one output file per source file, so `dist/src/**/*.js` and `dist/scripts/*.js` stay on the paths already-installed hooks call, and the shipped `src/sources.default.json` is copied next to the module that reads it.

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

1. When changesets land on `main`, `.github/workflows/publish.yml` opens or updates the release PR `chore(release): version packages` on the branch `changeset-release/main` by running `pnpm version-packages` (`changeset version`). Later changesets fold into the same PR.
2. The release PR uses the workflow's `GITHUB_TOKEN`; this workflow does not force it back to Draft. GitHub can create approval-required PR runs when that token opens, updates, or reopens a PR. If the PR shows **Approve workflows to run**, a maintainer with write access approves those runs. If no PR run is available, a maintainer can move the PR to Draft and then Ready to request CI through `ready_for_review`. Before merging, verify that the current release PR head has executed, successful Ubuntu and macOS CI jobs plus Review; a skipped Draft job is not sufficient. This repository's CI has no manual-dispatch trigger. See [GitHub's workflow-trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
3. Merging the release PR runs `publish.yml` again: gates, then `pnpm release` (`changeset publish`) publishes the unpublished version to npm through OIDC trusted publishing with provenance, and `changesets/action` pushes the tag and creates the matching GitHub Release.

Before merging the release PR, run the hook event queue's idle-exit race tests at 1,000 iterations; CI runs them at the default 100:

```bash
PRESENCE_RACE_RUNS=1000 pnpm test test/queue-idle-race.test.ts test/queue-command-race.test.ts
```

Two settings surfaces must stay in sync:

- **GitHub**: `PerfectPan/agent-presence` → Settings → Actions → General: allow read/write workflow permissions and let GitHub Actions create and approve pull requests, so the Changesets action can open the release PR.
- **npm**: `npmjs.com` → Packages → `@rivus/agent-presence` → Settings → Trusted publishing, using owner `PerfectPan`, repository `agent-presence`, workflow filename `publish.yml`. Renaming the workflow file breaks publishing until this setting changes too.

Trusted Publishing cannot be configured until the package exists on npm. To bootstrap a brand-new package, run one explicit publish with a short-lived granular npm token (outside the normal workflow), confirm the package exists, configure Trusted Publishing as above, then revoke the token and remove any temporary workflow changes.

### Bot Pull Requests

- **Renovate version PRs**: [`renovate.json`](renovate.json) enables the npm (including pnpm) and GitHub Actions
  managers. Renovate owns regular version updates for both ecosystems; this repository no longer configures
  Dependabot to open regular Actions version-update PRs.
  Automerge is disabled: require the CI and Review workflows to pass before a maintainer merges.
  Renovate checks on Mondays from 00:00 to 06:59 in Asia/Shanghai, waits seven days after a release, and opens at
  most five concurrent version-update PRs. The waiting period stays above the workspace's one-day install policy in
  [`pnpm-workspace.yaml`](pnpm-workspace.yaml). `@rivus/*` packages are exempt from the Renovate wait except for
  the kit/Effect group below; the workspace's install-time exclusions remain unchanged. `rangeStrategy: "bump"`
  updates declared ranges and regenerates the pnpm lockfile through `pnpm install`.

  GitHub Actions minor/patch updates have their own group; Actions major updates stay separate for individual
  review. The npm catch-all groups separate minor/patch updates from majors. Later rules give the `packages:vitePlus` toolchain
  its own group, and `@rivus/agent-kit`, `@rivus/agent-kit-collab` and `effect` a shared group. That group overrides
  the `@rivus/*` exemption with a seven-day wait for all three packages and sets `separateMajorMinor: false`.
  This removes policy and update-type splits, but different publication dates can still make versions eligible
  separately. Renovate grouping does not solve the kit's exact optional Effect peers or guarantee compatible
  versions. `pnpm test` first runs `pnpm peers check --lockfile-only` because frozen installs skip peer resolution; the narrow
  Vite+ alias exceptions in `pnpm-workspace.yaml` do not exempt kit/Effect peers. Review the generated lockfile
  and require that peer check and the single-Effect alignment test in `pnpm test` to pass before
  merging; if it fails, select compatible versions or wait for matching releases. A token-free local Renovate
  lookup does not generate or validate the final lockfile.

  The Vite+ exceptions name the current Vitest consumers and alias version exactly. Recheck them when upgrading
  the toolchain; do not widen them to suppress unrelated peer errors.

  Node upgrades remain deliberate: `engines`, `devEngines.runtime`, GitHub Actions Node runtime inputs and major
  `@types/node` updates are disabled. Enabling Actions updates does not enable Node runtime upgrades.
  `@perfectpan/lint-config` stays disabled because it is a Git dependency whose upgrades need accompanying code fixes.

  Lock-file maintenance runs on the first day of each month from 00:00 to 06:59 in Asia/Shanghai.

  `config:recommended` requests a **Dependency Dashboard** issue; after the hosted app creates it, use its
  checkboxes to retry or recreate an update. npm security findings can come from Renovate's OSV checks (`osvVulnerabilityAlerts`), and
  `vulnerabilityAlerts.rangeStrategy: "bump"` keeps security fixes on the tested `pnpm install` path. Security PRs
  can bypass release-age and schedule limits.

- **Actions update ownership**: Renovate is the sole regular version-update owner. If its hosted Actions updates
  fail, restore the [previous Dependabot Actions configuration](https://github.com/PerfectPan/agent-presence/blob/867ad7e635c44c88a86e648d241a83e267626109/.github/dependabot.yml)
  and pause Renovate's Actions updates while restoring coverage.

- **Security is a separate settings decision**: dependency graph and Dependabot alerts remain part of the target
  setup. Removing a Dependabot version-update file does not enable alerts or transfer security coverage. At the
  migration audit, the [repository security settings](https://github.com/PerfectPan/agent-presence/settings/security_analysis)
  showed dependency graph, Dependabot alerts and automatic security PRs disabled; this change does not alter those
  settings. The owner must separately enable the dependency graph and alerts, then
  verify that Renovate has permission to read vulnerability alerts and demonstrate a real hosted alert-to-fix PR
  with passing CI. OSV checks and `vulnerabilityAlerts` configuration alone do not establish that coverage. Agree
  on one primary security-PR owner only after that verification; do not disable existing security updates during
  a future handoff until the replacement is proven. If coverage cannot be demonstrated, retain any current
  coverage and explicitly arrange the interim security-PR owner with the maintainer.

- **Changesets**: bot PRs carry none. Dependency updates that do not change a published package's behavior need no
  changeset. If a bot PR changes published behavior (for example a bundled dependency changed), the reviewer adds a
  patch changeset before merging, per the section above.

### Model Prices

Model prices come from `@rivus/agent-kit/cost/prices`, the kit's snapshot of LiteLLM's price list, and update with the kit version: the kit refreshes the snapshot weekly and ships it in its next release, and upgrading `@rivus/agent-kit` brings those prices here. This repository keeps no price snapshot of its own. `src/usage/pricing.ts` holds only the fallback aliases for ids the kit's table does not name: the table's own Claude, GPT-5 and DeepSeek V4 models, so that their suffixed variants (`gpt-5.5-codex`, `claude-opus-4-8-thinking`) take their model's price; the Claude family aliases `opus`, `sonnet` and `haiku`; and the last list prices of models the table does not name. When a source records suffixed variants of another series, add the series to `ALIASED_SERIES` there; when it records a model the table drops, add the model's last list price.

## SDD Workflow And Document Lifecycle

1. Record the problem, affected users or maintainers, in-scope behavior, non-goals, and acceptance conditions.
2. Choose artifacts with the [Change Design Gate](#change-design-gate). Product work defaults to one behavioral Spec and one detailed Plan for the same deliverable. The Spec states required behavior: interactions and acceptance scenarios. The Plan owns the technical decisions (design, component and interface changes, data flow) and the detailed execution plan (ordered tasks, tests, exit conditions, validation, and rollback).
3. Review the behavior and technical design before implementing the affected scope. The Plan must resolve implementation decisions rather than leave them to the implementer; keep it blocked while a material decision is unresolved. New behavior revises the Spec. New implementation decisions revise the Plan.
4. Implement inside that boundary. Add evidence for each acceptance condition, or say why existing evidence is enough. Update current-state docs in the same change.
5. Before retiring a completed Spec or Plan, move still-valid behavior, invariants, and operational limits into current-state docs and tests. The final delivery PR may delete the completed files. Keep an unfinished Spec or Plan active. When the owner decides that a long-blocked, unfinished Spec or Plan should not stay active, its scope may move to an issue that states the goal, the blocker, and the independent parts, and links the files at a fixed commit; the files are then deleted.
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

A Plan records technical decisions and the detailed execution plan that implements them. Shared architecture, compatibility, security, and recovery decisions belong in a reviewed Plan. After implementation, move lasting constraints into current-state architecture or operations docs. This repository does not keep an RFC directory. The RFCs it used earlier remain in Git history: their delivered design is in [`docs/architecture.md`](docs/architecture.md), and the Token Usage RFC's unfinished follow-up is tracked in [issue #133](https://github.com/PerfectPan/agent-presence/issues/133). Removing a proposal does not mark unimplemented ideas as delivered.

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

Titles are English; `gh repo-checks pr-title` rejects CJK characters. Bot-generated PRs follow the same rule: the Changesets release PR uses `chore(release): version packages`, and dependency bots should emit titles such as `chore(deps): bump <package> to <version>`.

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

Workflows reference actions by their latest major version tag, such as `actions/checkout@v7`, not by commit SHA. The runtime follows the current Node.js Active LTS major in `.node-version`, and moves to the next LTS line in one change when it starts. Keep workflow structure copied from the project template in sync with that template. Renovate manages Action version updates in those workflows too; review and merge them through the same CI gates as other dependency PRs.

## Local Git Hooks

Install local hooks after cloning:

```bash
gh extension install PerfectPan/gh-repo-checks
./scripts/install-git-hooks.sh
```

The pre-commit hook runs `git diff --cached --check` and `gh repo-checks repository --staged` before a commit is created; without the extension it warns and skips the repository check. Hooks are a local guardrail; CI and branch protection remain the authoritative enforcement because hooks can be missing or bypassed.

If `core.hooksPath` is already set to another path, `scripts/install-git-hooks.sh` fails instead of overwriting it. Re-run with `--force` only after confirming the existing hooks can be replaced or moved into `.githooks`.

## Repository Setup

`main` is covered by the repository ruleset `Default`, which blocks deletion and force pushes. Required pull requests and status checks are not configured yet, so maintainers must confirm the actual CI and Review results before merging; a skipped check is not validation evidence. Preview the template's protection payload for this repository with:

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
