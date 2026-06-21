---
title: Providers
description: magic-builder (default) and feishu-signature (direct).
---

Both providers read the **same** l.garyyang slot. Slot value updates always flow to that backend; the provider only decides which preview URL Feishu embeds.

## `magic-builder` — default

A preview function on `magic.solutionsuite.cn`. On every Feishu link-preview fetch it runs server-side, reads the current slot value, and returns it as the title. It is the default because Feishu reliably renders this front-end even when it will not render the direct page.

It depends on `feishu-signature`: setup still needs the QR login (slot credential) **and** a Magic-Builder token to publish the function.

```bash
agent-presence setup            # default provider
agent-presence url              # https://magic.solutionsuite.cn/r?fid=...
```

## `feishu-signature` — direct alternative (legacy)

Serves the preview straight from `l.garyyang.work`, with no Magic-Builder token. Feishu may no longer render that page for personal-signature previews, so this path can quietly stop showing anything — prefer `magic-builder` unless you have confirmed the direct page still renders for you.

```bash
agent-presence setup --provider feishu-signature
agent-presence url --provider feishu-signature
```

Existing installs are unaffected by the default: `login` writes an explicit provider into your config, so the default only applies to fresh setups.
