# Documentation Standards

Use `docs/` for durable project knowledge that a maintainer or user cannot easily infer from reading the code alone. This includes current architecture and tradeoffs, development workflows, factual references, and validation boundaries.

Keep collaboration policy in `CONTRIBUTING.md`, AI-agent instructions in `AGENTS.md`, issue and review evidence requirements in templates, and automated enforcement in scripts or CI workflows. The user guide (install, providers, sources, token usage, command reference) is the Astro site under [`site/`](../site/), published at <https://agent-presence.vercel.app>.

## What Is Here

- [`architecture.md`](architecture.md): the current runtime architecture: hook and deferred paths, state machine, source table, token usage, providers, setup and uninstall idempotency, observability, failure model, and security boundaries.
- [`assets/`](assets/): diagrams referenced by the architecture document, with their editable SVG sources.

Add `guides/`, `reference/`, `architecture/`, or `development/` sections when the project has real documentation for that reader need. Do not create empty directories to match a list.

## Active Plans Boundary

- [`plans/`](plans/) contains active implementation plans only while non-trivial work is in flight.

The Change Design Gate in [`CONTRIBUTING.md`](../CONTRIBUTING.md#change-design-gate) decides when a change needs a plan. After the code lands on the default branch, move lasting non-code knowledge into `docs/` (and local `Why:` comments in code), move remaining follow-up items to issues, and delete the completed plan. Git history and the delivery PR keep the full plan, including the RFCs this repository used earlier.

## Writing Standards

- Give every durable document one clear audience, purpose, and owner area.
- Record what source code cannot express: _why_ a design or workaround was chosen, alternatives rejected, ownership and trust boundaries, external system quirks, and known validation limits.
- Do not duplicate directory trees, symbol lists, or type signatures that source code and type checks already express.
- Prefer current-state language over historical narration in `docs/`; link to the delivery PR for decision history.
- Keep examples runnable when practical; otherwise label them as illustrative and explain the validation gap.
- Link to source files, commands, schemas, or dashboards when they are the real source of truth.
- Update docs in the same change as behavior, configuration, command, API, deployment, architecture, or operational changes.
- Keep private tokens, internal hostnames, personal filesystem paths, generated logs, and environment-specific secrets out of documentation.
