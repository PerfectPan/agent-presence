# Changelog

## 0.1.0

### Minor Changes

- 05bf44d: Add the initial Agent Presence CLI for syncing local coding-agent lifecycle events to Feishu signature link previews.

### Patch Changes

- 05bf44d: Document the first npm publish bootstrap path and allow the release workflow to use a temporary NPM_TOKEN before Trusted Publishing is configured.
- 05bf44d: Use Clack prompts for human-facing CLI flows and split the CLI implementation into focused command, routing, UI, hook, and slot-sync modules.
- 05bf44d: Document macOS-only support, add runtime platform guards for CLI and installer scripts, and share JSON file helpers across config, state, and hook installers.
- 05bf44d: Document the runtime architecture and switch repository package management, CI, and release workflows to pnpm with explicit supply-chain safety settings.
