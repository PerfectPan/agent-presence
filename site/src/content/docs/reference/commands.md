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

agent-presence config show
agent-presence config render --zero "..." --one "..." --many "..."

agent-presence uninstall             # remove hooks (keeps credentials)
agent-presence uninstall --all
```

Hook commands are installed automatically by `setup` and never block the agent.
