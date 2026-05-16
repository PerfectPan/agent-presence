# Agent Presence

Sync local coding-agent presence to Feishu signature link previews.

[简体中文](README.zh-CN.md)

```text
Codex / Claude Code / Gemini CLI / opencode hooks
-> local presence state
-> debounced renderer
-> l.garyyang slot provider
-> Feishu signature link preview
```

`@rivus/agent-presence` is intentionally named around presence, not Feishu. The first supported output is Feishu signature previews through `l.garyyang.work`; the hook/state/render/provider shape can grow later.

## Install

Agent Presence currently supports macOS only. The CLI and installer scripts detect unsupported platforms and exit with a clear error; Windows is not supported yet because credential storage, hook installation paths, and power-event reset are macOS-specific in the MVP.

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
3. Let setup install Codex, Claude Code, Gemini CLI, opencode, and macOS power watchers.
4. Run `agent-presence url --provider feishu-signature`.
5. Paste that URL into Feishu profile signature as a custom link preview.

For the published package without installing globally:

```bash
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --provider feishu-signature
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest url --provider feishu-signature
```

`setup` installs local hooks and power watchers. It keeps credential material in Keychain and never embeds credentials in the Feishu signature URL.
`setup` starts QR login only when no credential is available. Rerunning setup with an existing Keychain credential will not require another QR scan. Use `agent-presence setup --skip-login --provider feishu-signature` to refresh hooks without login checks, or `agent-presence setup --login --provider feishu-signature` to force a fresh login.
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
agent-presence hook --source codex --event Stop
```

Hook commands never block the coding agent. Codex hooks print `{}`; Claude, Gemini, and opencode hooks run silent.

## Presence Semantics

This project counts agents that are actually working, not merely open terminal windows.

```text
SessionStart / UserPromptSubmit / PreToolUse / PostToolUse -> running / heartbeat
Stop / SessionEnd / session.idle                              -> finished
No heartbeat for 3 minutes                                    -> expired
Laptop sleep / lid close / screen sleep                       -> reset to 0
Wake                                                          -> reset to 0 again
```

Default render output:

```text
0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z
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
- macOS LaunchAgent power watcher

The power watcher listens for lid close, system sleep, screen sleep, wake, shutdown, reboot, and logout. Each event runs:

```bash
agent-presence reset --force --silent
```

This is best effort. Sudden power loss, forced shutdown, lost network, or provider rate limits can delay the remote slot update. Wake events reset again to pull stale remote state back to 0.

To remove local hooks, the opencode plugin, and the macOS power watcher:

```bash
agent-presence uninstall
```

The default uninstall intentionally keeps Keychain credentials, local state, and provider config so a later `agent-presence setup --skip-login` can reinstall hooks without another QR scan.

To also clear login credentials and the configured slot id:

```bash
agent-presence uninstall --credentials
```

To clear hooks, credentials, slot config, and local state:

```bash
agent-presence uninstall --all
```

Equivalent manual cleanup:

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

Credentials are stored in Keychain by default. Env overrides:

```bash
export AGENT_PRESENCE_TOKEN=...
export AGENT_PRESENCE_SLOT_ID=slot_xxx
export AGENT_PRESENCE_FEISHU_SIGNATURE_BASE_URL="https://l.garyyang.work"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_BASE_URL="https://l.garyyang.work/"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_IMAGE_KEY="img_xxx"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_TARGET_URL="https://example.com"
```

Token and slot credentials are not written to git and are not embedded in the signature URL.

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

The release workflow grants `id-token: write`, uses Node 24, and publishes without a long-lived npm write token. npm automatically generates provenance for public packages published through trusted publishing from public GitHub repositories.

If a package does not exist on npm yet, Trusted Publishing cannot be configured from its package page. Bootstrap that package once with a temporary granular npm token:

1. Create a short-lived npm granular access token with publish access to `@rivus/agent-presence` or the `@rivus` scope.
2. Add it to this GitHub repository as `NPM_TOKEN`.
3. Merge the release PR created by Changesets.
4. Confirm `@rivus/agent-presence` exists on npm.
5. Configure npm Trusted Publishing from the package page:

```text
npmjs.com -> Packages -> @rivus/agent-presence -> Settings -> Trusted publishing
GitHub owner: PerfectPan
Repository: agent-presence
Workflow filename: publish.yml
```

6. Delete the GitHub `NPM_TOKEN` secret and revoke the npm token.

Release flow:

1. Merge feature PRs with `.changeset/*.md` files.
2. `.github/workflows/publish.yml` opens or updates a `chore: release package` PR.
3. Review and merge that release PR.
4. The same workflow publishes to npm through Changesets and npm Trusted Publishing.

## Agent Skill

Reusable operator instructions live in [skills/agent-presence/SKILL.md](skills/agent-presence/SKILL.md). Install or symlink that skill into your agent skill directory if you want future agents to know how to install, verify, and debug Agent Presence.
