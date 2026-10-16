---
title: Commands
description: The agent-presence command surface.
---

Bare commands target the default `magic-builder` provider. Add `--provider feishu-signature` for the direct preview.

```bash
agent-presence setup                 # install hooks + link signature
agent-presence setup --login         # force a fresh QR login
agent-presence setup --skip-login    # refresh hooks only
agent-presence setup --no-hooks
agent-presence setup --hook-command absolute

agent-presence url                   # print the signature URL
agent-presence status                # what would render now
agent-presence status --remote       # what the live signature serves
agent-presence update --force        # push a render immediately
agent-presence reset --force         # clear the signature

agent-presence usage                 # today + last 7 days
agent-presence usage --days 7
agent-presence usage --json

agent-presence doctor                # check harness hooks and ledger
agent-presence doctor --json
agent-presence inventory             # ledger revision, entries and pending operations
agent-presence inventory --json

agent-presence config show
agent-presence config render --zero "..." --one "..." --many "..."

agent-presence source list                       # every counted source + its origin
agent-presence source add <npm-package> --yes     # install & register a source plugin
agent-presence source add <pkg> --registry <url> --id <id>
agent-presence source remove <id>                 # unregister + uninstall the package

agent-presence uninstall             # remove hooks (keeps credentials)
agent-presence uninstall --all
```

Hook commands are installed automatically by `setup` and never block the agent. See [Sources](/guide/sources/) for adding, overriding, or disabling the counted agents.

`doctor` prints each harness check with its status and exits non-zero for any warning or error. It checks Claude Code, Codex, Gemini CLI, Grok, opencode and Pi. Duplicate detection covers command-hook files, not opencode and Pi bridge files, and recognizes the current harness command; detection of commands from previous releases is not yet included. It does not repair agent configuration, though checking the ledger lock may create lock files in the harness state directory. `doctor` also reports `stale-path`, `unknown-event` and `timeout-unit` problems in other tools' hooks and exits 1 for them.

`inventory` prints the harness ledger revision, installed entries and pending operations. Both commands accept `--json`. The current `setup` still uses the existing installers, so its installations do not appear in the harness ledger; an empty inventory does not mean no presence hooks are installed. `inventory` includes every kit application's entries in the shared ledger, not only presence's.
