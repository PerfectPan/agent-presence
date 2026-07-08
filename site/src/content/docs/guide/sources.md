---
title: Sources
description: Add, override, or disable the coding agents that presence counts.
---

A **source** is a coding agent whose lifecycle presence is counted. Five ship built in — `codex`, `claude`, `gemini`, `opencode`, `pi` — and they live in one **source table** that your config can extend, override, or disable. Nothing is required: with no config, the five built-ins are in effect.

The table is `plugins.sources` in `~/.agent-presence/config.json`, keyed by source id. A same-id entry **overrides** a built-in, a new id **adds** a source, and `enabled: false` **disables** one. Check the effective table any time:

```bash
agent-presence config show      # includes the merged "sources" table
agent-presence source list      # just the table: id, origin, kind
```

## Add a source

There are three ways to define a source. Pick the simplest that fits.

### 1. Install a package — `source add`

The easiest path when a source ships as an npm package (for example an internal agent published to a private registry):

```bash
agent-presence source add @your-scope/agent-presence-youragent --yes
# internal registry:
agent-presence source add @your-scope/agent-presence-youragent \
  --registry https://npm.internal.example --id youragent --yes
```

`add` installs the package into an isolated directory (`~/.agent-presence/plugins/`), confirms it exports a valid source plugin, and records it in your config. `source remove <id>` unregisters and uninstalls it.

:::caution
A source plugin runs **in-process** with agent-presence and can read your slot credential. Only add packages you trust. `add` prints a trust notice and requires `--yes` or an interactive confirmation, and installs with `--ignore-scripts`.
:::

### 2. Declarative — no code

If the agent's hook payload is straightforward, map its fields directly in config — no module needed. Each field takes the same options as the built-in resolvers (`envKeys` / `payloadKeys` / `nestedPayloadKeys` / `payloadFirst`):

```jsonc
{
  "plugins": {
    "sources": {
      "youragent": {
        "match": {
          "sessionId": { "payloadKeys": ["session_id"], "payloadFirst": true },
          "project":   { "payloadKeys": ["cwd"], "payloadFirst": true },
          "event":     { "payloadKeys": ["hook_event_name"], "payloadFirst": true }
        }
      }
    }
  }
}
```

This tier runs no code and is the recommended way to onboard a standard agent.

### 3. A local handler module

For payloads with quirks (nested ids, event remapping), point at an ES module whose default export is a source plugin:

```jsonc
{
  "plugins": {
    "sources": {
      "youragent": { "handler": "/Users/me/.agent-presence/sources/youragent.mjs" }
    }
  }
}
```

```js
// youragent.mjs
export default {
  id: 'youragent',
  resolveHookContext(payload, env) {
    return { sessionId: payload.session_id, project: payload.cwd, event: payload.hook_event_name };
  }
};
```

Use an **absolute path** in a directory you own. agent-presence refuses a handler that is a symlink, not owned by you, or world-writable, and ignores `handler` entries entirely when `config.json` itself is world-writable.

Once a source resolves a `sessionId`, your agent must call the hook so events reach agent-presence:

```bash
agent-presence hook --source youragent --event SessionStart --silent
```

Wire that into your agent's own lifecycle hooks (payload on stdin).

## Override a built-in

Use the built-in id with your own `match` or `handler`. For example, change how `codex` reads its session id:

```jsonc
{ "plugins": { "sources": { "codex": { "match": { "sessionId": { "payloadKeys": ["my_id"], "payloadFirst": true } } } } } }
```

## Disable a built-in

```jsonc
{ "plugins": { "sources": { "gemini": { "enabled": false } } } }
```

`gemini` then disappears from the count and from `source list`.

## How resolution and trust work

Each table entry resolves by kind:

- **`builtin:<id>`** (the shipped defaults) — a trusted first-party resolver, receives the raw environment.
- **`match`** — compiled from your field spec, runs no code.
- **`handler`** — a JS module run in-process; guarded (credential-stripped environment, path/config ownership checks) and fail-open, so a broken source can never block a hook.

Trust follows the `builtin:` marker, not the id — so overriding a built-in with your own handler still runs through the guarded path.

`agent-presence uninstall --all` removes installed source packages along with hooks and state.
