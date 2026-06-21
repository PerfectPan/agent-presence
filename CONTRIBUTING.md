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

## Contribution Flow

1. Open an issue or discussion for ambiguous work.
2. Write an RFC for substantial changes.
3. Create a focused branch.
4. Add or update tests for behavior changes.
5. Update `CHANGELOG.md` for user-facing changes.
6. Run format, lint, test, and build checks.
7. Open a pull request with motivation, implementation notes, validation, and follow-up risks.

Small typo corrections, narrow documentation fixes, and repository metadata updates do not need an RFC.

## Required Checks

```bash
pnpm install --frozen-lockfile --ignore-scripts

pnpm test

pnpm run typecheck

pnpm run build

pnpm pack --dry-run
```

## When to Write an RFC

Use `rfcs/` when a change affects:

- public behavior
- install, deploy, or rollback safety
- trust boundaries
- configuration shape
- release process
- repository structure
- long-term integration strategy

RFCs should describe the problem, goals, non-goals, proposed design, alternatives, rollout plan, and risks.

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

## Release

The package is published as `@rivus/agent-presence` through Changesets and npm Trusted Publishing (OIDC) — the release workflow carries no long-lived npm write token.

For user-facing changes, add a changeset in the same PR:

```bash
pnpm run changeset
```

Release flow:

1. Merge feature PRs that include `.changeset/*.md` files.
2. `.github/workflows/publish.yml` opens or updates a `chore: release package` PR.
3. Review and merge that release PR.
4. `changesets/action` publishes to npm via Trusted Publishing and then creates the matching GitHub Release.

Two settings surfaces must stay in sync:

- **GitHub** — `PerfectPan/agent-presence` → Settings → Actions → General: allow read/write workflow permissions and let GitHub Actions create and approve pull requests, so the Changesets action can open the release PR.
- **npm** — `npmjs.com` → Packages → `@rivus/agent-presence` → Settings → Trusted publishing, using owner `PerfectPan`, repository `agent-presence`, workflow filename `publish.yml`.

Trusted Publishing cannot be configured until the package exists on npm. To bootstrap a brand-new package, run one explicit publish with a short-lived granular npm token (outside the normal workflow), confirm the package exists, configure Trusted Publishing as above, then revoke the token and remove any temporary workflow changes.

## Security Reports

Use `SECURITY.md` for vulnerability reporting guidance. Do not include secrets, exploit details, or private infrastructure in public issues or pull requests.
