# Documentation

Placement, writing rules, and plan retirement: [`docs/AGENTS.md`](AGENTS.md).
Contribution workflow and Change Design Gate: [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Index

- [`architecture.md`](architecture.md) — current runtime architecture: hook and deferred paths, state machine, source table, token usage, providers, setup and uninstall idempotency, observability, failure model, and security boundaries.
- [`assets/`](assets/) — diagrams referenced by `architecture.md`, with their editable SVG sources.
- [`plans/`](plans/) — active implementation plans; each is retired in its final delivery PR.

## Repository-Specific Surfaces

- The user guide (install, providers, sources, token usage, command reference) lives in the Astro site under [`site/`](../site/), published at <https://agent-presence.vercel.app>.
- Historical RFCs used before plans remain in Git history; delivered design lives in `architecture.md` and the remaining Token Usage follow-up is tracked in [issue #133](https://github.com/PerfectPan/agent-presence/issues/133).
