---
name: agent-presence
description: Use when installing, configuring, verifying, or debugging @rivus/agent-presence for Feishu signature link previews
---

# Agent Presence

## Overview

`@rivus/agent-presence` syncs local coding-agent lifecycle events to a Feishu signature link preview through `l.garyyang.work` slot updates. It does not scan processes; it trusts hooks, TTL, and power events.

## Use When

- A user wants Codex, Claude Code, or opencode activity shown in Feishu signature.
- Hooks are installed but the signature is stale.
- The count differs from visible terminal windows.
- Laptop sleep, lid close, or wake behavior needs verification.
- Credentials, slot URL, or `l.garyyang.work` provider state needs checking.

## Quick Commands

```bash
pnpm add -g @rivus/agent-presence
agent-presence setup --provider feishu-signature
agent-presence url --provider feishu-signature
agent-presence status --provider feishu-signature
agent-presence status --provider feishu-signature --remote
agent-presence update --provider feishu-signature --force
agent-presence reset --provider feishu-signature --force
```

Local checkout:

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup --provider feishu-signature
```

Configure the Feishu signature provider:

```bash
agent-presence config provider feishu-signature \
  --base-url "https://l.garyyang.work" \
  --preview-base-url "https://l.garyyang.work/" \
  --image-key "img_xxx" \
  --target-url "https://example.com"
```

## Mental Model

```text
agent hook event -> JSON state -> render text -> debounced slot update -> Feishu preview
```

Active means "currently working", not "terminal window exists":

```text
SessionStart/UserPromptSubmit/PreToolUse/PostToolUse -> running/heartbeat
Stop/SessionEnd/session.idle                         -> finished
3 minutes without heartbeat                          -> expired
sleep/lid close/screen sleep/wake                    -> reset to 0
```

## Debug Flow

1. Check local state:

   ```bash
   agent-presence status --provider feishu-signature
   ```

2. Check remote slot:

   ```bash
   agent-presence status --provider feishu-signature --remote
   ```

3. Inspect local log:

   ```bash
   tail -n 120 ~/.agent-presence/agent-presence.log ~/.agent-presence/agent-signature.log ~/.codex/agent-signature/agent-presence.log 2>/dev/null
   ```

4. Verify hooks exist:

   ```bash
   sed -n '1,240p' ~/.codex/hooks.json
   sed -n '1,320p' ~/.claude/settings.json
   sed -n '1,220p' ~/.config/opencode/opencode.json
   ```

5. Verify power watcher:

   ```bash
   launchctl print gui/$(id -u)/work.rivus.agent-presence.power-watch
   pgrep -fl 'agent-presence|power-watch|swift'
   ```

## Common Findings

- Remote stale but local value correct: provider debounce or 429; wait a minute and run `agent-presence update --force`.
- Setup asks for login unexpectedly: `setup` should start QR login only when no credential exists. If `status` shows `hasToken: true`, inspect Keychain and setup arguments; use `--skip-login` for hook-only repair.
- Visible Claude window not counted: it likely emitted `Stop` and is waiting for input, which is not "working".
- Extra Codex counted: another Codex session is still sending heartbeats; inspect `project` fields in `agent-presence status`.
- Sleep did not clear immediately: network or provider rate limit may have blocked the sleep-time reset; wake should reset again.
- Generic CLI naming is `agent-presence`; Feishu-specific link preview settings belong under provider id `feishu-signature`.

## Copy Templates

```bash
agent-presence config render \
  --zero "AI 牛马下班了" \
  --one "{total} 个 AI 牛马正在搬砖 | {details}" \
  --many "{total} 个 AI 牛马并行搬砖 | {details}"
```

`{total}` is active count. `{details}` is grouped source counts like `codex 1 · claude 2`.
