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

## Security Reports

Use `SECURITY.md` for vulnerability reporting guidance. Do not include secrets, exploit details, or private infrastructure in public issues or pull requests.
