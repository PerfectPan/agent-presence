# Documentation Standards

Use `docs/` for durable project knowledge that a maintainer should be able to read without replaying pull requests or chat history. This includes current architecture, development guides, operational runbooks, and factual references.

Keep collaboration policy in `CONTRIBUTING.md`, AI-agent instructions in `AGENTS.md`, issue and review evidence requirements in templates, and automated enforcement in scripts or CI workflows. The user guide (install, providers, sources, token usage, command reference) is the Astro site under [`site/`](../site/), published at <https://agent-presence.vercel.app>.

## What Is Here

- [`architecture.md`](architecture.md): the current runtime architecture: hook and deferred paths, state machine, source table, token usage, providers, setup and uninstall idempotency, observability, failure model, and security boundaries.
- [`assets/`](assets/): diagrams referenced by the architecture document, with their editable SVG sources.

Add `development/`, `reference/`, `operations/`, or `tutorials/` sections when the project has real documentation for that reader need. Do not create empty directories to match a list.

## Spec And Plan Boundary

- [`specs/`](specs/) declares active product behavior and acceptance contracts.
- [`plans/`](plans/) contains active technical decisions and detailed execution plans.

The Change Design Gate in [`CONTRIBUTING.md`](../CONTRIBUTING.md) decides which artifacts a change needs. After delivery, lasting constraints belong in current-state `docs/`. Git history keeps the retired Spec or Plan, including the RFCs this repository used before adopting Specs and Plans.

## Writing Standards

- Give every durable document one clear audience, purpose, and owner area.
- Prefer current-state language over historical narration in `docs/`; link to the delivery PR for decision history.
- Keep examples runnable when practical; otherwise label them as illustrative and explain the validation gap.
- Link to source files, commands, schemas, or dashboards when they are the real source of truth.
- Update docs in the same change as behavior, configuration, command, API, deployment, architecture, or operational changes.
- Keep private tokens, internal hostnames, personal filesystem paths, generated logs, and environment-specific secrets out of documentation.
