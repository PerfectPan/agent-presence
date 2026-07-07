# RFC: Presence Source Registry (onboard agents without a core change)

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
2. **The built-ins themselves**, which were resolved through a bespoke
   `if`-chain separate from any registry, unlike providers
   (`src/providers/registry.ts`).

Everything downstream of context resolution is already source-agnostic:
`AgentSession.source` is a plain `string` (`src/state.ts:11`), `renderDetails`
groups by `session.source` verbatim (`src/render.ts:128-137`), and
`normalizeEvent` already understands the PascalCase lifecycle events agents emit
(`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Stop` / `SessionEnd`,
`src/state.ts:242-276`). The only barrier is context resolution.

## Goals

- Unify all sources behind **one `SourcePlugin` interface and one registry**,
  mirroring the provider registry. The five built-ins become the interface's
  reference implementations, registered statically (bundled, zero trust cost).
- Let an additional source be onboarded through **configuration** — with no change
  to `@rivus/agent-presence` core code or release cadence — in two tiers:
  1. **Declarative** (zero code): map a source id to payload/env field names in
     `config.json`, reusing the existing `pickString` extraction helpers.
  2. **JS handler** (full control): point config at a loadable JS module (an npm
     specifier **or** an absolute file path) that exports a `SourcePlugin`.
- Preserve the hard invariant that a hook never throws into or blocks the agent:
  source loading and resolution are fail-open (log and fall back to `{}`).

## Non-Goals

- Token-usage scanning for config sources (`src/usage/*`). Usage scanning depends on
  each agent's private on-disk transcript format and pricing. The `SourcePlugin`
  interface could grow an optional `scanUsage` hook in a future RFC, but v1 wires
  only **presence** (the "N 个 AI 牛马正在搬砖" count).
- Auto-installing a config source's agent-side hooks from `agent-presence setup`.
  A config source's agent side is delivered through that agent's own mechanism;
  `setup` continues to install only the built-in agents, and `help` text stays
  built-in-only.
- Moving the built-ins to config loading. They stay statically registered: they
  ship with the package, have no trust boundary, and their resolvers carry real
  logic (claude subagent-id compositing, opencode event remapping, pi's
  session-start handling). "Built-in vs config" is just "registered statically vs
  registered from config", not two code paths.
- Full sandboxing of a config source handler. It runs in-process with the same
  trust as the CLI that imports it. v1 adds cheap guardrails (opt-in, path/config
  ownership checks, curated env) but does not isolate the handler. See Security.
- Changing storage, providers, rendering, or the state machine.

## Proposed Design

### 1. One `SourcePlugin` interface and registry

`src/cli/hook-context.ts` defines the interface and the built-in registry:

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
slot in unchanged. `isBuiltinSource(source)` and `resolveBuiltinHookContext` are
exposed; `resolveHookContext` stays as a thin back-compat alias so current callers
and tests are unaffected.

`src/sources.ts` layers config sources on top through a single async entry point:

```ts
export async function resolveHookContextForSource(
  source: string,
  payload: unknown,
  config: AppConfig
): Promise<SourceContext> {
  if (isBuiltinSource(source)) {
    // Built-ins are trusted and receive the raw environment (they use env fallbacks).
    return BUILTIN_SOURCE_PLUGINS[source].resolveHookContext(payload, process.env) ?? {};
  }
  const plugin = await loadConfiguredSource(source, config); // lazy, once per process
  if (!plugin) return {}; // unchanged fallback for truly unknown sources
  try {
    // Config sources receive a credential-stripped environment.
    return plugin.resolveHookContext(payload, curatedEnv(process.env)) ?? {};
  } catch (error) {
    await writeLog(`source resolve failed source=${source} error=${error?.name ?? 'Error'}`);
    return {};
  }
}
```

Built-in sources **always win** over a same-id config entry (checked first), and
`config show` flags a shadowed config entry. Core behavior must never be
redefinable by config.

### 2. Config schema

Extend `AppConfig` (`src/config.ts`) with a `plugins.sources` **id-keyed object**
(mirroring `providers/registry.ts`'s `Record<Id, …>`, which structurally prevents
duplicate ids):

```jsonc
{
  "plugins": {
    "sources": {
      // JS handler: npm specifier or absolute path. `handler` wins if `match` also present.
      "myagent":   { "handler": "/Users/me/.agent-presence/sources/myagent.mjs" },
      "otheragent": { "handler": "@company/agent-presence-otheragent" },

      // Declarative: no code. Each field is a full pickString spec (env + payload +
      // nested + precedence), so it can reproduce any built-in (e.g. codex's nesting).
      "thirdagent": {
        "match": {
          "sessionId": {
            "envKeys": ["THIRD_SESSION_ID"],
            "payloadKeys": ["session_id", "sessionId"],
            "nestedPayloadKeys": ["event", "session", "context"],
            "payloadFirst": true
          },
          "project": { "payloadKeys": ["cwd", "project"], "payloadFirst": true },
          "event":   { "payloadKeys": ["hook_event_name"], "payloadFirst": true }
        }
      }
    }
  }
}
```

**Resolution rules** (explicit to avoid footguns):

- Built-in ids (`codex`/`claude`/`gemini`/`opencode`/`pi`) always resolve to the
  built-in `SourcePlugin`; a same-id config entry is ignored and flagged.
- An entry with `handler` uses the JS module; `match` is ignored if both are set.
- An entry with only `match` compiles to a `SourcePlugin` built from `pickString`.
  Each of `sessionId` / `project` / `event` has the **same shape as
  `PickStringOptions`** (`envKeys` / `payloadKeys` / `nestedPayloadKeys` /
  `payloadFirst`), so config sources reach nested payloads and control
  env-vs-payload precedence exactly like the built-ins do (`src/hooks/context.ts:3-9`).
- An entry with neither is skipped and logged.

**Module resolution.** `handler` is resolved with dynamic `import()`. An absolute
path is converted via `pathToFileURL`. A bare specifier resolves through the
**agent-presence runtime's** module graph (`~/.agent-presence/runtime`, per
`docs/architecture.md`), *not* the user's cwd — so an internal package must be
installed there. Because that is easy to get wrong and harder to lock down,
**absolute paths under a user-owned directory are the recommended form** for
internal packages. The module's `default` export must be a `SourcePlugin` whose `id`
matches the config key (validated on load; mismatch is refused and logged).

Loading is lazy and cached per process: each `agent-presence hook` invocation is a
fresh short-lived Node process, so a handler is imported at most **once per hook**,
and only when its source actually fires. Built-ins stay static imports (zero import
cost); a config source pays one dynamic `import()` on its hot path — acceptable, and
the agent-side timeout is the only hard bound.

### 3. Wiring `hook`

`src/cli/commands/hook.ts` loads config **before** resolving context and calls
`resolveHookContextForSource(source, payload, config)`. Every hook — including ones
later dropped for a missing session id — now reads `config.json` first; that file is
small and already read on every non-dropped hook, so the cost is negligible. No
other command changes: presence counting, debounced rendering, and slot publishing
operate on the already-generic `AgentSession.source` string.

`agent-presence config show` gains a `sources` list describing every registered
source: its id, `origin` (`builtin` or `config`), and whether a config entry is
shadowed by a built-in — so users can confirm wiring without running a hook.

### 4. Security guardrails (v1)

A config `handler` runs in-process with full CLI trust, which **includes reading the
slot credential** (Keychain via `security find-generic-password`, or env tokens).
This is the same trust model as eslint/webpack config, but must be honest and
guarded:

- **Opt-in only.** No `plugins` key ⇒ no loading ⇒ byte-for-byte current behavior.
- **Curated env.** A config handler receives a filtered env (`curatedEnv`) with
  credential names stripped (`*TOKEN*`, `*SECRET*`, `*CREDENTIAL*`, `*SLOT_ID*`,
  `*PASSWORD*`, `*API_KEY*`), not raw `process.env`. Built-ins, being trusted,
  receive the raw environment (they need env fallbacks). In-process code can still
  read globals, but the default "we hand you the token" is removed and buggy handlers
  can't echo it.
- **Path validation for absolute handlers.** Before `import()`, `lstat` the resolved
  file and refuse (fail open + log) if it is a symlink, not owned by the current uid,
  or group/world-writable — mirroring the repo's `0o700`/reject-symlink posture.
- **Config trust.** Before honoring any `handler`, stat `config.json`; if it is
  world/group-writable or not user-owned, ignore `plugins.sources` handler entries
  and log. An attacker who can write config must not gain code execution.
- **Redaction-safe fail-open logging.** Handler failures log only non-secret fields
  (source id, `error.name`, resolved handler path) — never raw `error.message` or
  payload contents (there is no token redactor in `log-sanitize.ts`, so raw
  interpolation is unsafe). The resolved handler path is logged once at load time as
  an audit trail.

The `match` (declarative) tier runs **no** user code and is the recommended path for
standard agents; it is unaffected by the handler guardrails.

## Alternatives Considered

- **Keep the hardcoded `if`-chain and add sources case-by-case.** Rejected: forces
  a public release per source and, for a private agent, leaks internal details into
  an open-source repo.
- **Load the built-ins from config too.** Rejected: they ship with the package and
  have no trust boundary, so a per-hook dynamic import plus the handler guardrails
  would be pure overhead, and their resolver logic still has to live somewhere.
  Static registration keeps them zero-cost while sharing the interface.
- **Declarative-only (no JS handlers).** Rejected: sufficient for standard payloads
  but cannot express per-agent quirks (subagent-id compositing, event remapping like
  opencode's) — the exact reasons the built-ins are code, not config. We keep
  declarative as the easy, no-code tier and JS as the escape hatch.
- **A generic fallback resolver for any unknown source** (guess `session_id`/`cwd`).
  Rejected as the default: silently counting unknown sources with best-effort field
  guessing is surprising and hard to debug. The same behavior is available
  explicitly and legibly via a `match` spec.
- **Config as an array (`plugins.sources: []`).** Rejected in favor of an id-keyed
  object: the object mirrors the provider registry, makes shadow/collision detection
  trivial, and structurally forbids duplicate ids.
- **Load handlers once in a long-lived daemon.** Rejected: agent-presence has no
  daemon; hooks are short-lived processes. Per-process lazy import is adequate.

## Rollout Plan

- Minor release. Purely additive: no config `plugins` key means identical behavior,
  and built-in context resolution is behaviorally unchanged (same resolvers, now
  reached through the registry).
- Add this `rfcs/` entry; a `docs/architecture.md` section on the source registry,
  the handler trust boundary, and the guardrails; and a Changeset.
- **Re-scope the marketing guarantees in the same change** (AGENTS.md requires code
  and docs to agree): `README.md`'s "never logged" and the "credentials never leave
  the machine" framing are annotated to cover the **built-in path**, with an explicit
  note — parallel to the existing magic-builder exception — that a user-configured
  `handler` runs with full CLI trust (including credential read) and is the user's
  responsibility to vet.

## Risks

- **Arbitrary code execution + credential access from a `handler`.** A handler runs
  in-process and can read the slot credential regardless of Keychain vs env backend.
  Mitigations: opt-in; curated env (credentials stripped); absolute-path ownership /
  symlink / world-writable checks; `config.json` ownership check; audit-logged load;
  and the honest re-scoping of the "never logged / never leaves machine" guarantees.
  The no-code `match` tier is offered as the safe default for standard agents.
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
- **Event-name drift.** If a config source emits event names outside
  `normalizeEvent`'s vocabulary, they default to `heartbeat`. Documented; a handler
  (or `match.event`) may normalize event names before returning `SourceContext.event`.
- **Docs listing "five agents" go stale.** Mitigation: update `docs/architecture.md`
  and the site to describe the built-ins plus the registry extension point, framing
  the count as extensible rather than fixed.

## Review Notes

An earlier draft of this RFC was cross-reviewed by three independent agents
(architecture/API, security/trust-boundary, and integration realism). Their findings
are folded in above; the most material outcomes:

- `SourceContext` unified with the existing `HookContext` (no duplicate type), and
  all sources — built-in and config — resolve through one `SourcePlugin` registry
  rather than a separate `if`-chain and loader.
- Built-in dispatch is a registry keyed by id; built-ins always shadow same-id config
  entries.
- `plugins.sources` is an id-keyed object; each `match` field is a full
  `PickStringOptions`-shaped spec (fixes an earlier flat-list that could not reach
  nested payloads or set precedence).
- Security section: curated env for config handlers, path/config ownership checks,
  redaction-safe logging, a supply-chain subsection, and re-scoping of the "never
  logged" guarantee.
