# Agent Presence

Sync local coding-agent presence to Feishu signature link previews.

[简体中文](README.zh-CN.md)

```text
Codex / Claude Code / Gemini CLI / opencode / Pi Coding Agent hooks
-> local presence state
-> debounced renderer
-> l.garyyang slot provider
-> Feishu signature link preview
```

`@rivus/agent-presence` is intentionally named around presence, not Feishu. The first supported output is Feishu signature previews through `l.garyyang.work`; the hook/state/render/provider shape can grow later.

## Install

Agent Presence currently supports macOS and Linux. The CLI and installer scripts detect unsupported platforms and exit with a clear error; Windows is not supported yet.

macOS uses Keychain for credentials and installs a LaunchAgent power watcher. Linux uses libsecret through `secret-tool` for credentials and skips the power watcher because systemd user services and logind signals are not reliable across distributions; TTL pruning still clears expired sessions.

From the package registry:

```bash
pnpm add -g @rivus/agent-presence
agent-presence setup --provider feishu-signature
```

Without a global install:

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --provider feishu-signature
```

For agent environments that launch hooks with a restricted `PATH`, install hooks with absolute `node` and CLI paths:

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --provider feishu-signature --hook-command absolute
```

Codex may require you to approve updated hooks in Codex settings before they run. `setup` installs the
hooks and prints a reminder, but does not modify Codex trust state directly.

From a local checkout:

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup --provider feishu-signature
```

The package also exposes `agent-signature` as a compatibility alias, so old hooks keep working while new installs use `agent-presence`.

For the implementation shape and trust boundaries, see [docs/architecture.md](docs/architecture.md).

## User Flow

1. Run `agent-presence setup --provider feishu-signature`.
2. Scan the QR code if login is needed.
3. Let setup install Codex, Claude Code, Gemini CLI, opencode, and platform-specific watchers where supported.
4. Run `agent-presence url --provider feishu-signature`.
5. Paste that URL into Feishu profile signature as a custom link preview.

For the published package without installing globally:

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --provider feishu-signature
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest url --provider feishu-signature
```

`setup` installs local hooks and platform-specific watchers where supported. It keeps credential material in Keychain on macOS, libsecret on Linux, or explicit environment variables, and never embeds credentials in the Feishu signature URL.
`setup` starts QR login only when no credential is available. Rerunning setup with an existing credential will not require another QR scan. Use `agent-presence setup --skip-login --provider feishu-signature` to refresh hooks without login checks, or `agent-presence setup --login --provider feishu-signature` to force a fresh login.
When setup is run from `npx`, installed hooks use the package's fixed published version instead of a floating `latest` or a global `agent-presence` binary.
Local config, state, logs, and future managed runtimes live under `~/.agent-presence/`. If setup finds an older `~/.codex/agent-signature/` directory with known files that are still missing from the new home, it asks before copying them. Known legacy files are removed from the old home after they exist in `~/.agent-presence`; unknown files are left untouched.

`login`, `setup`, and interactive `config` flows use Clack prompts. Hook, status, update, reset, and URL commands keep script-safe output.

The URL contains only an encoded slot helper, not credentials:

```text
https://l.garyyang.work/?t2=<base62({{slot id="slot_xxx"}})>
```

## Commands

```bash
agent-presence login --provider feishu-signature
agent-presence setup --provider feishu-signature
agent-presence setup --provider feishu-signature --login
agent-presence setup --provider feishu-signature --skip-login
agent-presence setup --provider feishu-signature --no-hooks
agent-presence setup --provider feishu-signature --hook-command absolute
agent-presence uninstall
agent-presence uninstall --credentials
agent-presence uninstall --all
agent-presence url --provider feishu-signature
agent-presence status --provider feishu-signature
agent-presence status --provider feishu-signature --remote
agent-presence usage
agent-presence usage --days 7
agent-presence usage --days 1 --json
agent-presence update --provider feishu-signature --force
agent-presence reset --provider feishu-signature --force
agent-presence config show
agent-presence config provider feishu-signature --base-url "https://l.garyyang.work" --preview-base-url "https://l.garyyang.work/" --image-key "img_xxx" --target-url "https://example.com"
agent-presence config render --zero "AI 牛马下班了" --one "{total} 个 AI 牛马正在搬砖 | {details}" --many "{total} 个 AI 牛马并行搬砖 | {details}"
```

Hook commands are installed automatically by `setup`, but can be called directly:

```bash
agent-presence hook --source codex --event SessionStart
agent-presence hook --source claude --event SessionStart --silent
agent-presence hook --source gemini --event SessionStart --silent
agent-presence hook --source opencode --event SessionStart --silent
agent-presence hook --source pi --event SessionStart --silent
agent-presence hook --source codex --event Stop
```

Hook commands never block the coding agent. Codex hooks print `{}`; Claude, Gemini, and opencode hooks run silent.

## Token Usage

`agent-presence usage` reports token consumption over calendar-day windows, in
the spirit of [`ccusage`](https://github.com/ryoppippi/ccusage): it does not hook
the agents, it scans their local transcripts after the fact.

```bash
agent-presence usage            # today and the last 7 days side by side
agent-presence usage --days 7   # a single calendar-day window
agent-presence usage --json     # structured output for scripts
```

Sources and how cost is derived:

| Source | Transcript | Cost |
| --- | --- | --- |
| `claude` | `~/.claude/projects/**/*.jsonl` (honours `CLAUDE_CONFIG_DIR`) | priced from the table; de-duplicated by `message.id` + `requestId` keeping the final (largest) occurrence; `<synthetic>` turns excluded — verified to match `ccusage` |
| `codex` | `~/.codex/sessions/` and `~/.codex/archived_sessions/` | priced from the table; diffs the cumulative `total_token_usage` per session (summing per-event `last_token_usage` double-counts ~1.6x) |
| `pi` | `~/.pi/agent/sessions/**/*.jsonl` | uses the cost Pi already records in the transcript |
| `gemini` | — | not tracked: Gemini does not persist per-message token usage locally |

A window of N days spans N local calendar days inclusive of today —
`[startOfLocalDay(now) - (N-1)*24h, now)`. So `今日` (1 day) counts from local
midnight and resets at 00:00 rather than sliding as a rolling 24h window would
(which makes the figure drop mid-day as old activity ages out). Cost shows `n/a`
when a model has no entry in the pricing table; token counts are always exact.

The default pricing is best-effort and will drift; override it per model
(USD per million tokens) without a code change:

```jsonc
// ~/.agent-presence/config.json
{
  "usage": {
    "showInSignature": false,        // append "今日 …" to the signature title
    "signatureWindowDays": 1,        // window used by the signature badge
    "pricing": { "opus": { "input": 15, "output": 75 } }
  }
}
```

Usage in the signature is driven by render-template variables, so you compose
your own label and choose which windows to show:

| Variable | Meaning |
| --- | --- |
| `{usage}` | badge for the default window (`usage.signatureWindowDays`, default 1) |
| `{usage_1d}` | rolling 1-day badge, e.g. `2.1M · $4.50` |
| `{usage_7d}` | rolling 7-day badge — any `{usage_Nd}` works |

```bash
agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d} · 近7天 {usage_7d}"
```

Referencing any `{usage*}` token enables scanning for the windows it names. For a
zero-config option, set `usage.showInSignature: true` (or
`AGENT_PRESENCE_USAGE_IN_SIGNATURE=1`) to auto-append the default window
(labelled `今日` for 1 day, `近N天` otherwise) without editing templates.

Badges are refreshed by a full transcript rescan only on **session-boundary
events** (a session starting or finishing); high-frequency tool events reuse the
cached badges and never trigger a scan. Because each scan reads the entire
rolling window, any single refresh yields the complete, correct total — so
boundary-only refresh stays accurate without a background timer or cron. The
trade-off: while a session is mid-flight the badge reflects the total as of its
last boundary, not the live in-progress count.

Because nothing runs while the machine is idle or off, a cached badge can outlive
its window (e.g. yesterday's `今日` total still showing the next morning). To
avoid displaying a number that has quietly gone wrong, a badge whose whole window
has rolled over since it was computed — one midnight for `今日`, seven days for
`近7天` — renders as `—` until the next session-boundary refresh recomputes it.
The label you wrote in the template stays; only the value collapses to the
placeholder.

## Presence Semantics

This project counts agents that are actually working, not merely open terminal windows.

```text
SessionStart / UserPromptSubmit / PreToolUse / PostToolUse -> running / heartbeat
Pi before_agent_start / turn_start / tool_execution_*      -> running / heartbeat
Stop / SessionEnd / session.idle / agent_end / session_shutdown -> finished
No heartbeat for 3 minutes                                    -> expired
Expired + later live heartbeat                                -> running again
Laptop sleep / lid close / screen sleep                       -> reset to 0
Wake                                                          -> reset to 0 again
```

`finished` is explicit and ignores late ordinary heartbeats. `expired` is TTL-inferred inactivity, so a later live heartbeat can reopen the same session.

For Pi specifically, opening the `pi` TUI on its own is not counted as active: presence only activates when Pi fires `before_agent_start`, which happens once the user actually submits a task.

Default render output:

```text
0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P
```

The value is capped at 200 characters.

## Copywriting

Configure templates:

```bash
agent-presence config render \
  --zero "AI 牛马下班了" \
  --one "{total} 个 AI 牛马正在搬砖 | {details}" \
  --many "{total} 个 AI 牛马并行搬砖 | {details}"
```

Variables:

```text
{total}   active agent count
{details} grouped source counts, for example: codex 1 · claude 1
```

Environment overrides:

```bash
export AGENT_PRESENCE_RENDER_ZERO="AI 牛马暂未开工"
export AGENT_PRESENCE_RENDER_ONE="{total} 个 AI 牛马正在搬砖 | {details}"
export AGENT_PRESENCE_RENDER_MANY="{total} 个 AI 牛马并行搬砖 | {details}"
```

Legacy `AGENT_SIGNATURE_*` environment names are still accepted.

## Hooks And Watchers

`agent-presence setup` installs:

- Codex hooks in `~/.codex/hooks.json`
- Claude Code hooks in `~/.claude/settings.json`
- Gemini CLI hooks in `~/.gemini/settings.json`
- opencode plugin in `~/.config/opencode/plugins/agent-presence.js`
- Pi Coding Agent extension in `~/.pi/agent/extensions/agent-presence.ts`
- macOS LaunchAgent power watcher; Linux setup skips the watcher and relies on TTL pruning

The Pi extension is auto-discovered by Pi from `~/.pi/agent/extensions/*.ts`. It subscribes to Pi's lifecycle events (`before_agent_start`, `turn_start`, `tool_execution_*`, `agent_end`, `session_shutdown`) and never scans processes or terminal windows. Reruns of `setup` overwrite only the managed file; `uninstall` removes only that file and leaves other Pi extensions and settings untouched.

The power watcher listens for lid close, system sleep, screen sleep, wake, shutdown, reboot, and logout. Each event runs:

```bash
agent-presence reset --force --silent
```

The watcher is best effort on macOS. Sudden power loss, forced shutdown, lost network, or provider rate limits can delay the remote slot update. Wake events reset again to pull stale remote state back to 0. On Linux, setup prints a watcher-skip message and the 3-minute TTL clears expired sessions.

To remove local hooks, the opencode plugin, and the macOS power watcher:

```bash
agent-presence uninstall
```

The default uninstall intentionally keeps credentials, local state, and provider config so a later `agent-presence setup --skip-login` can reinstall hooks without another QR scan.

To also clear login credentials and the configured slot id:

```bash
agent-presence uninstall --credentials
```

To clear hooks, credentials, slot config, and local state:

```bash
agent-presence uninstall --all
```

Equivalent macOS manual cleanup:

```bash
security delete-generic-password -s 'agent-signature:l-garyyang' -a token 2>/dev/null || true
security delete-generic-password -s 'agent-signature:l-garyyang' -a slotId 2>/dev/null || true
security delete-generic-password -s 'agent-signature-slot-credential' -a "${USER:-agent-presence}" 2>/dev/null || true
printf '{}\n' > ~/.agent-presence/config.json
# Legacy config path, used by older installs:
printf '{}\n' > ~/.codex/agent-signature/config.json
```

Manual package scripts remain available from a local checkout:

```bash
pnpm run install:all-hooks
pnpm run uninstall:all-hooks
pnpm run install:shutdown-watcher
pnpm run uninstall:shutdown-watcher
```

## Provider

The first provider id is `feishu-signature`. Its current slot backend is `l.garyyang.work`:

```http
GET  /api/slot/wechat/qrcode
GET  /api/slot/wechat/login-status?sceneId=...
POST /api/slot/update
GET  /api/slot/info
```

Configure provider-specific link preview fields:

```bash
agent-presence config provider feishu-signature \
  --base-url "https://l.garyyang.work" \
  --preview-base-url "https://l.garyyang.work/" \
  --image-key "img_xxx" \
  --target-url "https://example.com"
```

Credentials are stored in Keychain on macOS and libsecret on Linux by default. Env overrides:

```bash
export AGENT_PRESENCE_TOKEN=...
export AGENT_PRESENCE_SLOT_ID=slot_xxx
export AGENT_PRESENCE_FEISHU_SIGNATURE_BASE_URL="https://l.garyyang.work"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_BASE_URL="https://l.garyyang.work/"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_IMAGE_KEY="img_xxx"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_TARGET_URL="https://example.com"
```

Token and slot credentials are not written to git and are not embedded in the signature URL.

### `magic-builder` provider (Magic-Builder FaaS bridge)

`magic-builder` is an alternate provider for when the `l.garyyang.work` link-preview page is not being rendered by Feishu (e.g. Feishu has tightened the iframe whitelist for personal-signature link previews). It uses the same l.garyyang slot backend for value storage but fronts it with a Magic-Builder FaaS so the resulting signature URL lives under `magic.solutionsuite.cn`, which Feishu's link-preview pipeline accepts.

```bash
# Requires an existing l.garyyang login so the published FaaS can read your
# slot value; run `agent-presence login --provider feishu-signature` first if
# you have not already. Then:
agent-presence setup --provider magic-builder --hook-command absolute
```

When run in an interactive terminal with no token configured, setup prints the
token instructions and prompts you to paste the token, then stores it in the OS
keyring (Keychain on macOS, libsecret on Linux). To get the token:

1. In Feishu, open the 妙笔 (Magic-Builder) bot: <https://applink.larkoffice.com/T94fcr4NqQPz>
2. Send the message `dev`.
3. Copy the token from its reply.

Non-interactive environments can supply the token without the prompt:

```bash
export MAGIC_TOKEN=<token>          # one-off, highest precedence
# or, skill-pack compatible plaintext file (read, never written by this CLI):
echo <token> > ~/.magic-token && chmod 600 ~/.magic-token
```

Token resolution order: `MAGIC_TOKEN` env → OS keyring → `~/.magic-token` → `<cwd>/.magic-token`.

`setup` builds a CommonJS FaaS that embeds your slot id and bearer, POSTs it to `https://magic.solutionsuite.cn/api/faas`, and stores the returned `record_id` under `providers.magic-builder.faasId`. The resulting signature URL is:

```text
https://magic.solutionsuite.cn/r?fid=<record_id>
```

Re-running `setup --provider magic-builder` updates the same FaaS in place (idempotent). Hooks continue to write into the l.garyyang slot exactly as before — the FaaS pulls from `/api/slot/info` each time Feishu refreshes the preview (default cache `60s`).

Env / config overrides:

```bash
export MAGIC_TOKEN=...                                # publish token
export AGENT_PRESENCE_MAGIC_BUILDER_BASE_URL=...      # override magic.solutionsuite.cn
export AGENT_PRESENCE_MAGIC_BUILDER_FAAS_ID=rec_...   # pin an existing FaaS record id
export AGENT_PRESENCE_MAGIC_BUILDER_FAAS_NAME=...     # override default `agent_presence_preview`
export AGENT_PRESENCE_MAGIC_BUILDER_FALLBACK_TITLE=...# rendered when the slot read fails
```

The token is stored in the OS keyring under service `agent-presence:magic-builder`. The published FaaS embeds your l.garyyang slot bearer so it can read the slot value; rotating that bearer requires re-running `setup --provider magic-builder` to re-publish.

Inspect the live preview the FaaS would return:

```bash
agent-presence status --provider magic-builder --remote
# → .remote.faas.title, .remote.faas.expireStrategy
```

## Logs

Hook failures and selected provider requests are written to:

```text
~/.agent-presence/agent-presence.log
```

Override the log path with:

```bash
export AGENT_PRESENCE_LOG_FILE=/path/to/agent-presence.log
```

Provider request logs are single-line key/value records with redacted fields. Successful login QR and login polling requests are not logged by default; failures, rate limits, slot updates, and slot info reads are logged.
Timestamps are written as China time with an explicit `+08:00` offset for easier local trace reading.

```text
time=2026-05-16T21:59:49.227+08:00 level=info app=agent-presence pid=12345 type=provider.request provider=feishu-signature method=POST path=/api/slot/update status=200 durationMs=123 slotId=slot_xxx... valueLength=31 result=updated
```

The log never writes bearer tokens, full Authorization headers, QR code tickets, raw provider response bodies, or full slot values.

## Validation

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
pnpm pack --dry-run

agent-presence status
agent-presence url
agent-presence update --force
agent-presence status --remote

CODEX_THREAD_ID=fake-2 agent-presence hook --source codex --event SessionStart
agent-presence status
CODEX_THREAD_ID=fake-2 agent-presence hook --source codex --event Stop
agent-presence status
```

### Verifying Pi Coding Agent locally

Install Pi without running install scripts, then install Agent Presence support:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
agent-presence setup --provider feishu-signature --skip-login --hook-command absolute
```

The Pi extension is written to `~/.pi/agent/extensions/agent-presence.ts` and is picked up automatically by `pi`. To smoke-test with a real LLM, inject your provider key from a local file and run a non-interactive Pi prompt — the example uses Z.ai's GLM-5.1 because it is the model the project tests against:

```bash
export ZAI_API_KEY="$(tr -d '\r\n' < /path/to/your/zai-key.txt)"
pi --provider zai --model glm-5.1 -p "Reply with exactly: pi-ok"

agent-presence status --provider feishu-signature
agent-presence status --provider feishu-signature --remote
```

Read the key from a file outside the repository so it never enters your shell history, git index, or process listing as a literal value. `ZAI_API_KEY` is the standard Z.ai environment-variable name and is safe to mention in docs; the actual key value must stay out of every committed file.

## Release

The package is published as `@rivus/agent-presence`.

This repository uses Changesets. For user-facing changes, add a changeset in the same PR:

```bash
pnpm run changeset
```

Package management is pinned to pnpm through `packageManager`. CI and release use the checked-in `pnpm-lock.yaml`, frozen installs, dependency script blocking, and the workspace supply-chain settings in `pnpm-workspace.yaml`.

Publishing uses npm Trusted Publishing / OIDC. There are two settings surfaces to keep in sync:

1. GitHub repository settings for the release PR workflow.
2. npm package settings for the trusted package publisher.

In GitHub, open `PerfectPan/agent-presence` -> Settings -> Actions -> General. Under Workflow permissions, allow read and write permissions and enable GitHub Actions to create and approve pull requests. The workflow file still declares its own narrower permissions, but the repository setting must allow the Changesets action to open or update the release PR.

In npm, configure Trusted Publishing from the existing package page:

```text
npmjs.com -> Packages -> @rivus/agent-presence -> Settings -> Trusted publishing
```

Use these GitHub Actions publisher fields:

```text
GitHub owner: PerfectPan
Repository: agent-presence
Workflow filename: publish.yml
```

The release workflow grants `id-token: write`, uses Node 24, and does not pass a long-lived npm write token. npm automatically generates provenance for public packages published through trusted publishing from public GitHub repositories.

`changesets/action` owns both release PR creation and package publishing. When publishing succeeds, its default `createGithubReleases` behavior creates a GitHub Release for the published package version, so the repository Releases page shows the same version that was published to npm.

If a package does not exist on npm yet, Trusted Publishing cannot be configured from its package page. Keep the committed release workflow tokenless, and bootstrap the package once with a temporary granular npm token outside the normal trusted-publishing path:

1. Create a short-lived npm granular access token with publish access to `@rivus/agent-presence` or the `@rivus` scope.
2. Run one explicit bootstrap publish using that token, either from a temporary one-off workflow change or from a clean local checkout after `pnpm pack --dry-run`.
3. Confirm `@rivus/agent-presence` exists on npm.
4. Configure npm Trusted Publishing from the package page:

```text
npmjs.com -> Packages -> @rivus/agent-presence -> Settings -> Trusted publishing
GitHub owner: PerfectPan
Repository: agent-presence
Workflow filename: publish.yml
```

5. Remove any temporary workflow/token changes and revoke the npm token.

Release flow:

1. Merge feature PRs with `.changeset/*.md` files.
2. `.github/workflows/publish.yml` opens or updates a `chore: release package` PR.
3. Review and merge that release PR.
4. `changesets/action` publishes to npm through Changesets and npm Trusted Publishing.
5. After a successful publish, `changesets/action` creates the matching GitHub Release.

## Agent Skill

Reusable operator instructions live in [skills/agent-presence/SKILL.md](skills/agent-presence/SKILL.md). Install or symlink that skill into your agent skill directory if you want future agents to know how to install, verify, and debug Agent Presence.
