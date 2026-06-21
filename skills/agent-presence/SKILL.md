---
name: agent-presence
description: Use when installing, configuring, verifying, or debugging @rivus/agent-presence for Feishu signature link previews
---

# Agent Presence

## Overview

`@rivus/agent-presence` syncs local coding-agent lifecycle events to a Feishu signature link preview. Presence values are written to a hosted slot store; the default `magic-builder` provider fronts that slot with a FaaS preview on `magic.solutionsuite.cn` (Feishu may not render the older direct preview page). It does not scan processes; it trusts hooks, TTL, and power events.

## Use When

- A user wants Codex, Claude Code, Gemini CLI, opencode, or Pi Coding Agent activity shown in Feishu signature.
- Hooks are installed but the signature is stale.
- The count differs from visible terminal windows.
- Laptop sleep, lid close, or wake behavior needs verification.
- Credentials, the published FaaS, or the underlying slot state needs checking.
- Linux libsecret or watcher-skip behavior needs verification.

## Quick Commands

Bare commands target the default `magic-builder` provider. The first `setup` runs the QR login (stores the slot credential) and prompts for a Magic-Builder token to publish the preview FaaS (open the 妙笔 bot, send `dev`, copy the token).

```bash
pnpm add -g @rivus/agent-presence
agent-presence setup
agent-presence url
agent-presence status
agent-presence status --remote        # inspects the published FaaS preview
agent-presence update --force
agent-presence reset --force
```

Local checkout:

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup
```

The older direct-preview provider (`--provider feishu-signature`, no Magic-Builder token) is a legacy alternative; Feishu may no longer render it. Its link-preview fields are configured separately (use the slot host's base URL):

```bash
agent-presence config provider feishu-signature \
  --base-url "https://<slot-host>" \
  --preview-base-url "https://<slot-host>/" \
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
Pi before_agent_start/turn_start/tool_execution_*    -> running/heartbeat
Stop/SessionEnd/session.idle/agent_end/session_shutdown -> finished
3 minutes without heartbeat                          -> expired
sleep/lid close/screen sleep/wake                    -> reset to 0
```

Pi only counts as active once the user submits a task (`before_agent_start`). Opening the `pi` TUI without prompting is intentionally not counted.

## Debug Flow

1. Check local state:

   ```bash
   agent-presence status
   ```

2. Check the published preview, and the raw slot value behind it:

   ```bash
   agent-presence status --remote                          # FaaS preview the default provider returns
   agent-presence status --provider feishu-signature --remote  # raw slot value
   ```

3. Inspect local log:

   ```bash
   tail -n 120 ~/.agent-presence/agent-presence.log ~/.agent-presence/agent-signature.log ~/.codex/agent-signature/agent-presence.log 2>/dev/null
   ```

4. Verify hooks exist:

   ```bash
   sed -n '1,240p' ~/.codex/hooks.json
   sed -n '1,320p' ~/.claude/settings.json
   sed -n '1,220p' ~/.gemini/settings.json
   sed -n '1,220p' ~/.config/opencode/opencode.json
   sed -n '1,160p' ~/.pi/agent/extensions/agent-presence.ts
   sed -n '1,160p' ~/.pi/agent/settings.json 2>/dev/null || true
   ```

5. Verify platform watcher:

   ```bash
   launchctl print gui/$(id -u)/work.rivus.agent-presence.power-watch
   pgrep -fl 'agent-presence|power-watch|swift'
   # Linux intentionally skips the watcher; TTL pruning handles expiry.
   ```

## Common Findings

- Remote stale but local value correct: provider debounce or 429; wait a minute and run `agent-presence update --force`.
- Setup asks for login unexpectedly: `setup` should start QR login only when no credential exists. If `status` shows `hasToken: true`, inspect Keychain and setup arguments; use `--skip-login` for hook-only repair.
- Linux credential errors usually mean `secret-tool` or the system keyring is unavailable; env vars still work for automation.
- Visible Claude window not counted: it likely emitted `Stop` and is waiting for input, which is not "working".
- Extra Codex counted: another Codex session is still sending heartbeats; inspect `project` fields in `agent-presence status`.
- Sleep did not clear immediately: network or provider rate limit may have blocked the sleep-time reset; wake should reset again.
- Generic CLI naming is `agent-presence`; the default provider is `magic-builder`. Direct-preview link settings belong under provider id `feishu-signature`, which is also the slot backend both providers share.
- Remote shows the fallback title (e.g. `AI 牛马暂未开工`) while the slot has a live value: the FaaS could not read the slot — re-run `setup` to re-publish with a fresh slot bearer.

## Copy Templates

```bash
agent-presence config render \
  --zero "AI 牛马下班了" \
  --one "{total} 个 AI 牛马正在搬砖 | {details}" \
  --many "{total} 个 AI 牛马并行搬砖 | {details}"
```

`{total}` is active count. `{details}` is grouped source counts like `codex 1 · claude 2 · gemini 1 · pi 1`.

## Pi Coding Agent Notes

- Setup installs the extension at `~/.pi/agent/extensions/agent-presence.ts`. Pi auto-discovers files in that directory.
- The extension shells out to `agent-presence hook --source pi --event <name> --silent`; failures are swallowed so Pi itself never crashes.
- Activation gates on `before_agent_start`, not `session_start`, so an idle Pi TUI is not counted.
- `agent_end` and `session_shutdown` deliver Stop synchronously to avoid leaving stale active state after a quick `pi -p` run exits.
- To verify locally with a real LLM, read your provider key from a file outside the repo and run a non-interactive prompt, e.g.:

  ```bash
  export ZAI_API_KEY="$(tr -d '\r\n' < /path/to/zai-key.txt)"
  pi --provider zai --model glm-5.1 -p "Reply with exactly: pi-ok"
  agent-presence status
  agent-presence status --remote
  ```

  Never paste the literal key into shell history, commits, PR descriptions, or docs — only the file path and the environment-variable name are safe.
