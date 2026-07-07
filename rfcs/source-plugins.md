# RFC: Presence Source Table (onboard, override, or disable agents by config)

## Status

Accepted (revised after cross-review — see "Review Notes")

## Problem

Agent Presence counts coding-agent "sources". The shipped set is `codex`,
`claude`, `gemini`, `opencode`, `pi`, and until now each was wired by a hardcoded
`if (source === 'codex') … 'pi'` chain in `src/cli/hook-context.ts`. Adding a
source required editing core code and cutting a new `@rivus/agent-presence`
release, touching `src/setup.ts`, `scripts/install-*`, `package.json`, and
`src/cli/help.ts` along the way. An unknown source fell through to `return {}`,
yielding no `sessionId`, so `hook` silently dropped the event
(`src/cli/commands/hook.ts:29-33`).

That is a poor fit for two situations:

1. **Agents that cannot ship in the public package** — an internal or
   organization-private coding agent whose lifecycle wiring, package, and payload
   quirks must not live in an open-source repo, and which should not force a public
   release each time it changes.
2. **Operators who want to tune or disable a built-in** — no config-level control
   existed, and the built-ins were resolved through a bespoke `if`-chain separate
   from any table.

Everything downstream of context resolution is already source-agnostic:
`AgentSession.source` is a plain `string` (`src/state.ts:11`), `renderDetails`
groups by `session.source` verbatim (`src/render.ts:128-137`), and
`normalizeEvent` already understands the PascalCase lifecycle events agents emit
(`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Stop` / `SessionEnd`,
`src/state.ts:242-276`). The only barrier is context resolution.

## Goals

- Model **every** source — first-party and third-party — as an entry in one
  **source table**. The five built-ins ship as a default table
  (`src/sources.default.json`); a user's `config.plugins.sources` merges over it.
- Let an operator, through `~/.agent-presence/config.json` and with no change to
  `@rivus/agent-presence` core code or release cadence:
  - **add** a source (a new id),
  - **override** a source (a same-id entry replaces the default),
  - **disable** a source (`enabled: false` drops it).
- Support two ways to define a source's resolution:
  1. **Declarative** (zero code): map fields to payload/env keys, reusing the
     existing `pickString` extraction helpers.
  2. **JS handler** (full control): a loadable module (npm specifier or absolute
     path) that exports a `SourcePlugin`.
- Keep the built-ins' command-shaped logic (claude subagent-id compositing,
  opencode event remapping, pi's session-start handling) intact by referencing it
  from the table via a `builtin:<id>` handler, rather than trying to re-express it
  as declarative config.
- Preserve the hard invariant that a hook never throws into or blocks the agent:
  source loading and resolution are fail-open (log and fall back to `{}`).

## Non-Goals

- Token-usage scanning for non-built-in sources (`src/usage/*`). Usage scanning
  depends on each agent's private on-disk transcript format and pricing. The
  `SourcePlugin` interface could grow an optional `scanUsage` hook in a future RFC,
  but v1 wires only **presence** (the "N 个 AI 牛马正在搬砖" count).
- Auto-installing a source's agent-side hooks from `agent-presence setup`. A
  non-built-in source's agent side is delivered through that agent's own mechanism;
  `setup` continues to install only the built-in agents, and `help` text stays
  built-in-only.
- Re-expressing the built-ins' resolver logic as declarative config. Their logic is
  command-shaped and stays in code; the table references it via `builtin:<id>`.
- Full sandboxing of a JS handler. It runs in-process with the same trust as the
  CLI that imports it. v1 adds cheap guardrails (opt-in, path/config ownership
  checks, curated env) but does not isolate the handler. See Security.
- Changing storage, providers, rendering, or the state machine.

## Proposed Design

### 1. The `SourcePlugin` interface

`src/cli/hook-context.ts` defines the one contract every source resolves through,
and keeps the five built-in resolvers as its reference implementations:

```ts
export type SourceContext = HookContext; // { event?; sessionId?; project? }

export interface SourcePlugin {
  id: string;
  /**
   * Turn a hook payload (and environment) into presence context. MUST be
   * synchronous and do no I/O: it runs on the hook hot path, and the only hard
   * bound is the agent-side hook timeout.
   */
  resolveHookContext(payload: unknown, env?: StringEnv): SourceContext;
}

export const BUILTIN_SOURCE_PLUGINS: Record<string, SourcePlugin> = {
  codex: { id: 'codex', resolveHookContext: resolveCodexHookContext },
  claude: { id: 'claude', resolveHookContext: resolveClaudeHookContext },
  gemini: { id: 'gemini', resolveHookContext: resolveGeminiHookContext },
  opencode: { id: 'opencode', resolveHookContext: resolveOpenCodeHookContext },
  pi: { id: 'pi', resolveHookContext: resolvePiHookContext }
};
```

The five existing resolvers already share the `(payload, env)` signature, so they
slot in unchanged; the table (below) reaches them through the `builtin:<id>`
handler form.

### 2. The shipped default table and the merge

`src/sources.default.json` ships with the package and lists the built-ins as
`builtin:<id>` handlers:

```json
{
  "sources": {
    "codex": { "handler": "builtin:codex" },
    "claude": { "handler": "builtin:claude" },
    "gemini": { "handler": "builtin:gemini" },
    "opencode": { "handler": "builtin:opencode" },
    "pi": { "handler": "builtin:pi" }
  }
}
```

`src/sources.ts` computes the **effective table** as the shipped defaults with the
user's `config.plugins.sources` merged over them by id:

```ts
export function mergedSources(config: AppConfig): Record<string, SourcePluginConfig> {
  const merged = { ...defaultSources() };            // shipped default-table
  for (const [id, entry] of Object.entries(config.plugins?.sources ?? {})) {
    merged[id] = entry;                              // same id overrides; new id adds
  }
  for (const [id, entry] of Object.entries(merged)) {
    if (entry.enabled === false) delete merged[id];  // disable drops the source
  }
  return merged;
}
```

So a user's `config.json` can:

```jsonc
{
  "plugins": {
    "sources": {
      // add: a new internal agent via a JS handler
      "myagent": { "handler": "/Users/me/.agent-presence/sources/myagent.mjs" },

      // add: a no-code source via a declarative match spec
      "otheragent": {
        "match": {
          "sessionId": { "payloadKeys": ["session_id"], "payloadFirst": true },
          "project":   { "payloadKeys": ["cwd"], "payloadFirst": true },
          "event":     { "payloadKeys": ["hook_event_name"], "payloadFirst": true }
        }
      },

      // override: replace a built-in's resolution
      "codex": { "match": { "sessionId": { "payloadKeys": ["my_id"], "payloadFirst": true } } },

      // disable: stop counting a built-in
      "gemini": { "enabled": false }
    }
  }
}
```

Not writing a `plugins.sources` (or a given id) leaves the shipped default in
effect — "default can be omitted".

### 3. Resolution and trust

`src/cli/commands/hook.ts` loads config and calls
`resolveHookContextForSource(source, payload, config)`, which looks the id up in the
merged table and resolves by entry kind:

- **`builtin:<id>`** — reuse the shipped in-code resolver
  (`BUILTIN_SOURCE_PLUGINS[id]`). **Trusted**: it is first-party code that ships with
  the package, so it receives the **raw** environment (built-ins rely on env
  fallbacks like `CODEX_THREAD_ID`).
- **JS `handler`** (npm specifier or absolute path) — dynamically `import()`ed. Runs
  in-process, so it is guarded (below) and receives a **credential-stripped**
  environment.
- **`match`** — compiled to a `SourcePlugin` from `pickString`. Each of `sessionId`
  / `project` / `event` has the same shape as `PickStringOptions` (`envKeys` /
  `payloadKeys` / `nestedPayloadKeys` / `payloadFirst`), so it reaches nested
  payloads and controls precedence like a built-in. Runs no user code.
- A disabled or unknown id resolves to `{}` — the unchanged silent-skip fallback.

Trust follows the **`builtin:` marker, not the id**: a user who overrides `codex`
with their own `handler` gets the guarded, credential-stripped path, even though the
id is a built-in one.

`agent-presence config show` prints the merged table as `sources`, each entry with
its `origin` (`default`/`config`), `kind` (`builtin`/`handler`/`match`), and whether
it `overridesDefault` — so users can confirm wiring without running a hook.

### 4. Security guardrails (v1)

A JS `handler` runs in-process with full CLI trust, which **includes reading the
slot credential** (Keychain via `security find-generic-password`, or env tokens).
This is the same trust model as eslint/webpack config, but must be honest and
guarded. `builtin:` entries are exempt (first-party shipped code); the guards apply
to `handler` entries:

- **Opt-in only.** No `plugins.sources` override ⇒ shipped defaults only ⇒
  byte-for-byte current behavior.
- **Curated env.** A handler receives a filtered env (`curatedEnv`) with credential
  names stripped (`*TOKEN*`, `*SECRET*`, `*CREDENTIAL*`, `*SLOT_ID*`, `*PASSWORD*`,
  `*API_KEY*`), not raw `process.env`. In-process code can still read globals, but
  the default "we hand you the token" is removed and buggy handlers can't echo it.
- **Path validation for absolute handlers.** Before `import()`, `lstat` the resolved
  file and refuse (fail open + log) if it is a symlink, not owned by the current uid,
  or group/world-writable — mirroring the repo's `0o700`/reject-symlink posture.
- **Config trust.** Before honoring any `handler`, stat `config.json`; if it is
  world/group-writable or not user-owned, ignore `handler` entries and log. An
  attacker who can write config must not gain code execution.
- **Redaction-safe fail-open logging.** Handler failures log only non-secret fields
  (source id, `error.name`, resolved handler path) — never raw `error.message` or
  payload contents (there is no token redactor in `log-sanitize.ts`, so raw
  interpolation is unsafe). The resolved handler path is logged once at load time as
  an audit trail.

The `match` (declarative) tier runs **no** user code and is the recommended path for
standard agents; it is unaffected by the handler guardrails.

**Module resolution.** `handler` is resolved with dynamic `import()`. An absolute
path is converted via `pathToFileURL`. A bare specifier resolves through the
**agent-presence runtime's** module graph (`~/.agent-presence/runtime`), *not* the
user's cwd — so an internal package must be installed there. Absolute paths under a
user-owned directory are the recommended form for internal packages.

Loading is lazy and cached per process: each `agent-presence hook` invocation is a
fresh short-lived Node process, so a handler is imported at most **once per hook**,
and only when its source actually fires. `builtin:` entries are static imports (zero
import cost); a JS handler pays one dynamic `import()` on its hot path — acceptable,
and the agent-side timeout is the only hard bound.

## Alternatives Considered

- **Keep the hardcoded `if`-chain and add sources case-by-case.** Rejected: forces
  a public release per source and, for a private agent, leaks internal details into
  an open-source repo. It also offered no way to override or disable a built-in.
- **Re-express the built-ins as declarative `match` in the default table.** Rejected:
  claude/opencode/pi carry command-shaped logic (subagent-id compositing, event
  remapping, session-start handling) that a field-mapping spec cannot express.
  `builtin:<id>` keeps that logic in code while still listing every source in one
  data table.
- **Declarative-only (no JS handlers).** Rejected: sufficient for standard payloads
  but cannot express per-agent quirks — the exact reason the built-ins are code, not
  config. We keep declarative as the easy, no-code tier and JS as the escape hatch.
- **A generic fallback resolver for any unknown source** (guess `session_id`/`cwd`).
  Rejected as the default: silently counting unknown sources with best-effort field
  guessing is surprising and hard to debug. The same behavior is available
  explicitly and legibly via a `match` spec.
- **Config as an array (`plugins.sources: []`).** Rejected in favor of an id-keyed
  object: the object makes merge/override/disable trivial and structurally forbids
  duplicate ids.
- **Never let config override a built-in id.** Rejected: overriding and disabling a
  built-in are explicit goals here. Trust is tied to the `builtin:` marker, not the
  id, so an override drops to the guarded path automatically.

## Rollout Plan

- Minor release. Purely additive: no `plugins.sources` override means the shipped
  default table is in effect, and built-in resolution is behaviorally unchanged
  (same resolvers, now reached via `builtin:<id>`).
- Ship `src/sources.default.json` in the package (`build` copies it to
  `dist/src/`), add this `rfcs/` entry, a `docs/architecture.md` section on the
  source table and trust boundary, and a Changeset.
- **Re-scope the marketing guarantees in the same change** (AGENTS.md requires code
  and docs to agree): `README.md`'s "never logged" and the "credentials never leave
  the machine" framing are annotated to cover the **built-in / default path**, with
  an explicit note — parallel to the existing magic-builder exception — that a
  user-configured `handler` runs with full CLI trust (including credential read) and
  is the user's responsibility to vet.

## Risks

- **Arbitrary code execution + credential access from a `handler`.** A handler runs
  in-process and can read the slot credential regardless of Keychain vs env backend.
  Mitigations: opt-in; curated env (credentials stripped); absolute-path ownership /
  symlink / world-writable checks; `config.json` ownership check; audit-logged load;
  and the honest re-scoping of the "never logged / never leaves machine" guarantees.
  The no-code `match` tier is the safe default for standard agents, and `builtin:`
  entries are first-party.
- **Overriding or disabling a built-in changes core counting behavior.** This is
  intentional and operator-driven. Mitigation: `config show` surfaces every override
  and omission, so the effective table is inspectable; the shipped default is
  unchanged unless a user opts in.
- **Supply chain.** A runtime `import()` bypasses the package's install-time controls
  (frozen lockfile, `--ignore-scripts`, `minimumReleaseAge`, `blockExoticSubdeps`).
  A **bare specifier** additionally risks dependency-confusion / typosquatting if the
  internal scope isn't reserved on the public registry. Mitigation: recommend
  absolute paths under a user-owned dir; if a specifier is used, require an
  org-reserved scope. An internal package can change in-process code without a public
  release — the flip side of the "no public release" goal — so vetting is the
  operator's responsibility.
- **A slow or hanging handler delays a hook.** The `resolveHookContext` contract is
  "synchronous, no I/O," but the framework cannot enforce it; a handler *can* do
  arbitrary I/O. The only hard bound is the agent-side hook command's `timeout` + `||
  true` guard, so a misbehaving handler can never block the agent — it can only fail
  its own hook. Stated honestly rather than as a "pure function" guarantee.
- **Missing shipped defaults.** If `sources.default.json` is somehow absent at
  runtime, `defaultSources()` falls back to the in-code built-in ids as
  `builtin:<id>`, so presence never silently stops counting first-party agents.
- **Event-name drift.** If a source emits event names outside `normalizeEvent`'s
  vocabulary, they default to `heartbeat`. Documented; a handler (or `match.event`)
  may normalize event names before returning `SourceContext.event`.

## Review Notes

An earlier draft of this RFC was cross-reviewed by three independent agents
(architecture/API, security/trust-boundary, and integration realism). Their findings
are folded in above; the most material outcomes:

- `SourceContext` unified with the existing `HookContext` (no duplicate type), and
  all sources resolve through one `SourcePlugin` contract.
- The model moved from "built-ins static + config extends" to a single **merged
  source table**: a shipped default JSON (built-ins as `builtin:<id>`) plus a user
  config that can add, override, or disable any id — with trust keyed on the
  `builtin:` marker rather than the id.
- `plugins.sources` is an id-keyed object; each `match` field is a full
  `PickStringOptions`-shaped spec (fixes an earlier flat-list that could not reach
  nested payloads or set precedence).
- Security section: curated env for handlers, path/config ownership checks,
  redaction-safe logging, a supply-chain subsection, and re-scoping of the "never
  logged" guarantee.
