# Changelog

## 0.2.3

### Patch Changes

- 35829a2: Avoid repeated legacy-home migration prompts by removing known legacy files after they exist in `~/.agent-presence`.

## 0.2.2

### Patch Changes

- 47ce8a2: Add absolute hook command installation for restricted PATH agent environments, move the default local home to `~/.agent-presence` with setup-time legacy migration, remind users to approve changed Codex hooks, record redacted provider request logs, and accept Codex desktop conversationId payloads.

## 0.2.1

### Patch Changes

- 46ae26f: Fix opencode presence so lifecycle events use real session ids instead of event or message ids, load the generated plugin as a default export, and prevent late async heartbeats from resurrecting finished sessions.

## 0.2.0

### Minor Changes

- fde39ee: Add Gemini CLI support for agent presence synchronization including hooks and auto-installation scripts.

## 0.1.4

### Patch Changes

- 036ffe7: Prefer Claude hook payload session ids over process env ids so stop events target the same session as start and heartbeat events.
- a14cbcd: Fix Codex setup and uninstall deduplication for fixed-version npx hook commands.

## 0.1.3

### Patch Changes

- 11b9515: Fix Codex stop events that report an unstable session id by finishing the latest matching running session instead of leaving the active count unchanged.

## 0.1.2

### Patch Changes

- 89e9cd7: Add a first-class `agent-presence uninstall` command for local hooks, plugins, and the power watcher, support credential/state cleanup flags, install npx-compatible fixed-version hook commands, and migrate the release workflow to npm Trusted Publishing/OIDC.

## 0.1.1

### Patch Changes

- 8b6776a: Fix Feishu signature login parsing for confirmed credential responses.

## 0.1.0

### Minor Changes

- 05bf44d: Add the initial Agent Presence CLI for syncing local coding-agent lifecycle events to Feishu signature link previews.

### Patch Changes

- 05bf44d: Document the first npm publish bootstrap path and allow the release workflow to use a temporary NPM_TOKEN before Trusted Publishing is configured.
- 05bf44d: Use Clack prompts for human-facing CLI flows and split the CLI implementation into focused command, routing, UI, hook, and slot-sync modules.
- 05bf44d: Document macOS-only support, add runtime platform guards for CLI and installer scripts, and share JSON file helpers across config, state, and hook installers.
- 05bf44d: Document the runtime architecture and switch repository package management, CI, and release workflows to pnpm with explicit supply-chain safety settings.
