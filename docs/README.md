# Documentation

Placement, writing rules, and plan retirement: [`docs/AGENTS.md`](AGENTS.md).
Contribution workflow and Change Design Gate: [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Index

- [`architecture/overview.md`](architecture/overview.md) — system pipeline, CLI hook-graph boundary, stable shim, configuration, observability, failure model, security boundaries, and release safety.
- [`architecture/hook-pipeline.md`](architecture/hook-pipeline.md) — state store, hook event queue, hook normalization, session state machine, active semantics, rendering, and debounce.
- [`architecture/providers-and-sources.md`](architecture/providers-and-sources.md) — provider registry, source table and token usage (`scanUsage`), slot and Magic-Builder backends, and Linux credential/power integration.
- [`architecture/installation.md`](architecture/installation.md) — setup idempotency, upgrades and downgrades, installed agent artifacts, Codex hook trust, and uninstall.
- [`assets/`](assets/) — diagrams referenced by `architecture/hook-pipeline.md`, with their editable SVG sources.
- [`plans/`](plans/) — active implementation plans; each is retired in its final delivery PR.

## Repository-Specific Surfaces

- The user guide (install, providers, sources, token usage, command reference) lives in the Astro site under [`site/`](../site/), published at <https://agent-presence.vercel.app>; its visual design notes live in [`site/DESIGN.md`](../site/DESIGN.md).
- The installable agent skill for configuring and debugging `@rivus/agent-presence` lives in [`skills/agent-presence/SKILL.md`](../skills/agent-presence/SKILL.md).
- Historical RFCs used before plans remain in Git history; delivered design lives under [`architecture/`](architecture/overview.md) and the remaining Token Usage follow-up is tracked in [issue #133](https://github.com/PerfectPan/agent-presence/issues/133).
