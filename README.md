# Agent Presence

Sync local coding-agent presence (and token usage) to a Feishu signature link preview.

[简体中文](README.zh-CN.md) · [Documentation](https://agent-presence.vercel.app)

```text
Codex / Claude Code / Gemini CLI / opencode / Pi hooks
  -> local presence state
  -> debounced renderer
  -> hosted slot store (value storage)
  -> magic-builder FaaS preview on magic.solutionsuite.cn
  -> Feishu signature link preview
```

`@rivus/agent-presence` is named around presence, not Feishu. The default output is the **magic-builder** FaaS preview on `magic.solutionsuite.cn`: presence values are written to a hosted slot store, and the FaaS reads them server-side on each Feishu preview fetch. magic-builder is the default because Feishu may not render the older direct preview page.

## Install

macOS and Linux only — Windows exits with a clear error. macOS uses Keychain and installs a LaunchAgent power watcher; Linux uses libsecret and relies on TTL pruning instead of a watcher.

```bash
pnpm add -g @rivus/agent-presence
agent-presence setup
```

Without a global install:

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup
```

For agent environments that launch hooks with a restricted `PATH`, pin absolute `node`/CLI paths:

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --hook-command absolute
```

From a local checkout:

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup
```

`agent-signature` stays available as a compatibility alias, so old hooks keep working. See [docs/architecture.md](docs/architecture.md) for the implementation shape and trust boundaries.

## Quick start

1. Run `agent-presence setup`.
2. Scan the QR code if login is needed; this stores the slot credential.
3. Paste a Magic-Builder token when prompted so setup can publish the preview FaaS — open the 妙笔 bot, send `dev`, copy the token from its reply.
4. Setup installs hooks for Codex, Claude Code, Gemini CLI, opencode, and Pi, plus the macOS power watcher.
5. Run `agent-presence url` and paste it into your Feishu profile signature as a custom link preview.

Re-running `setup` reuses an existing login (no second QR scan). The signature URL — `https://magic.solutionsuite.cn/r?fid=<faasId>` — carries no credentials. Local config, state, and logs live under `~/.agent-presence/`.

> An older direct-preview provider (`--provider feishu-signature`, no Magic-Builder token) also exists, but Feishu may no longer render it. See [Providers](https://agent-presence.vercel.app/guide/providers/) if you still want it.

## Presence

Counts agents that are actually working, not merely open terminal windows. A session goes running → `finished` (explicit, ignores late heartbeats) or `expired` (no heartbeat for 3 minutes; a later live heartbeat reopens it). Laptop sleep, lid close, and wake reset the count to 0.

```text
0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P
```

Full event mapping: [Presence semantics](https://agent-presence.vercel.app/guide/presence/).

## Token usage

`agent-presence usage` scans the agents' local transcripts after the fact (it does not hook them), in the spirit of [`ccusage`](https://github.com/ryoppippi/ccusage), over **calendar-day** windows — `今日` counts from local midnight rather than sliding as a rolling 24h window.

```bash
agent-presence usage            # today and the last 7 days side by side
agent-presence usage --days 7   # a single calendar-day window
agent-presence usage --json     # structured output for scripts
```

Surface it in the signature with render variables (`{usage_1d}`, `{usage_7d}`) or `usage.showInSignature: true`. Supported models are priced from a bundled LiteLLM snapshot (private models can still use pricing overrides); sources and the stale-badge `—` guard: [Token usage](https://agent-presence.vercel.app/guide/token-usage/).

## Configure copy

```bash
agent-presence config render \
  --zero "AI 牛马下班了" \
  --one "{total} 个 AI 牛马正在搬砖 | {details}" \
  --many "{total} 个 AI 牛马并行搬砖 | {details}"
```

`{total}` is the active agent count and `{details}` the grouped source counts (e.g. `codex 1 · claude 1`). `AGENT_PRESENCE_RENDER_*` environment overrides also work; legacy `AGENT_SIGNATURE_*` names are still accepted.

## Commands

```bash
agent-presence setup            # also: --login --skip-login --no-hooks --hook-command absolute
agent-presence url
agent-presence status           # --remote inspects the published preview
agent-presence usage            # --days N / --json
agent-presence update --force
agent-presence reset --force
agent-presence uninstall        # --credentials / --all
agent-presence config show
```

Hooks are installed by `setup` but can be invoked directly, e.g. `agent-presence hook --source codex --event SessionStart`. They never block the coding agent. Full reference: [Commands](https://agent-presence.vercel.app/reference/commands/).

## Sources

The counted agents (`codex`, `claude`, `gemini`, `opencode`, `pi`) are a **source table** your config can extend, override, or disable. Add one with a config-only `match` spec, a local `handler` module, or by installing a package:

```bash
agent-presence source add @your-scope/agent-presence-youragent --yes   # --registry <url> for an internal registry
agent-presence source list
agent-presence source remove youragent
```

A source plugin runs in-process and can read your slot credential, so `add` requires confirmation and only trusted packages should be added. Override or disable a built-in via `plugins.sources` in `~/.agent-presence/config.json`. Full guide: [Sources](https://agent-presence.vercel.app/guide/sources/).

## Logs

Hook and provider activity is written to `~/.agent-presence/agent-presence.log` (override with `AGENT_PRESENCE_LOG_FILE`). Bearer tokens, full Authorization headers, QR tickets, and full slot values are never logged.

## Documentation

Full docs live at **https://agent-presence.vercel.app**:

- [Install](https://agent-presence.vercel.app/guide/install/) · [Quick start](https://agent-presence.vercel.app/guide/quick-start/)
- [Providers](https://agent-presence.vercel.app/guide/providers/) — magic-builder (default) vs the legacy direct preview
- [Sources](https://agent-presence.vercel.app/guide/sources/) — add, override, or disable the counted agents
- [Presence](https://agent-presence.vercel.app/guide/presence/) · [Token usage](https://agent-presence.vercel.app/guide/token-usage/)
- [Architecture](https://agent-presence.vercel.app/project/architecture/) · [Commands](https://agent-presence.vercel.app/reference/commands/)

## Contributing & releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, required checks, and the Changesets / npm Trusted Publishing release flow.

## Agent skill

Reusable operator instructions live in [skills/agent-presence/SKILL.md](skills/agent-presence/SKILL.md). Install or symlink that skill into your agent skill directory so future agents know how to install, verify, and debug Agent Presence.
