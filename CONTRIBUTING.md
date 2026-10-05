# Contributing

## Development Setup

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
node dist/src/cli.js --help
```

The installer scripts (`pnpm run install:*` / `uninstall:*`) and `agent-presence setup` write to the real agent configs, Keychain, and LaunchAgents under your home directory. When trying them from a checkout, run them with `HOME="$(mktemp -d)"` unless you mean to change your own setup.

## Contribution Flow

1. Open an issue or discussion for ambiguous work.
2. Choose Spec and Plan artifacts using the [Change Design Gate](#change-design-gate) before substantial work, and review the behavior and technical design before implementing that scope.
3. Create a focused branch.
4. Add or update tests for behavior changes.
5. Add a changeset for user-facing package changes.
6. Run the [Required Checks](#required-checks).
7. Update `README.md`, `README.zh-CN.md`, `docs/`, `site/`, or the active Spec and Plan when user-facing behavior, architecture, workflow, or operations change.
8. Open a pull request with motivation, implementation notes, validation, and follow-up risks.
9. Keep the PR description current after review feedback, rebases, validation reruns, or scope changes.

Small fixes, typo corrections, dependency metadata updates, and narrow documentation improvements do not need a separate Spec and Plan.

## Required Checks

CI (`.github/workflows/ci.yml`) runs these on every pull request; run them locally before opening review:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
pnpm pack --dry-run
```

When a change touches `site/`, also build the docs site with `pnpm -C site run docs:build`. For package-facing changes, run `pnpm changeset status` and inspect the `pnpm pack --dry-run` file list.

## Changesets

Use Changesets for the package version and changelog entries:

```bash
pnpm run changeset
```

Choose `patch`, `minor`, or `major` according to the impact on users of the published CLI. Documentation-only changes, repository metadata changes, tests, and internal maintenance that do not affect the published package can skip a changeset.

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

| Change type | Required artifact |
| --- | --- |
| Product behavior | One Spec plus one detailed Plan for the same deliverable |
| Technical refactor without changed user behavior | Detailed Plan with compatibility and acceptance conditions |
| Narrow maintenance, tests, or documentation | Requirement and PR checklist; a separate Plan only when useful |

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

Every PR should answer:

- What changed?
- Why is this change needed?
- How was this tested?
- Are there follow-up tasks or risks?

## Repository Hygiene

Do not commit private tokens, local config, generated workspaces, internal hostnames, or personal filesystem paths.

Keep package or deploy contents intentional. If a file should ship, verify it appears in the package or deployment dry-run.

Use the pinned pnpm version from `packageManager`. Do not commit `package-lock.json`, local `.npmrc` credentials, generated `dist/`, or `node_modules/`.

## Security Reports

Use [`SECURITY.md`](SECURITY.md) for vulnerability reporting guidance. Do not include secrets, exploit details, or private infrastructure in public issues or pull requests.
