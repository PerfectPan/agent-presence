# RFC: Unify token/cost accounting under the source table (`scanUsage`)

## Status

Proposed

## Problem

agent-presence now has two subsystems that both answer "which coding agents are
running":

- **Presence** — unified behind one abstraction (RFC
  [`source-plugins.md`](./source-plugins.md)): every source is a `SourcePlugin`
  in one merged **source table** (`sources.default.json` `builtin:<id>` entries +
  a user's `config.plugins.sources`), resolved through `src/sources.ts`.
- **Usage** — the `agent-presence usage` command that reports token/cost by
  scanning each agent's local transcript after the fact (ccusage-style). This is
  still the **old, hardcoded** system and does not know the source table exists:
  - `UsageSource = 'claude' | 'codex' | 'pi'` — a fixed union.
  - `SOURCE_ORDER = ['claude','codex','pi']` and `collectWindowUsage()`
    hardcodes `Promise.all([scanClaude, scanCodex, scanPi])`.
  - Scanners exist only for claude/codex/pi.

So a source is not "one thing that declares all its capabilities": presence is a
table entry, but billability is bolted on elsewhere as a hardcoded trio. Adding a
billable agent means editing the union, the order array, and the `Promise.all`,
in addition to (or instead of) the source table. Two of the five built-ins
(opencode, gemini) contribute presence but no usage, even though both persist
per-message token data locally.

There is also a **documentation bug**: several docs claim "Gemini does not persist
per-message token usage locally". That is false for current Gemini CLI (see
[Verified data](#verified-data)), and AGENTS.md requires docs to match code.

## Goals

- Make token/cost accounting a **capability of the same source abstraction**: a
  source is one `SourcePlugin` that optionally implements `scanUsage`. Implement
  it → the source is billable; omit it → the source is presence-only.
- Rewrite `collectWindowUsage()` to iterate the sources in the merged table that
  expose `scanUsage`, instead of a hardcoded trio. Relax `UsageSource` from a
  fixed union to `string`.
- Wire the three existing scanners (`scanClaude` / `scanCodex` / `scanPi`) onto
  their built-in `SourcePlugin.scanUsage` unchanged (reuse, do not rewrite).
- Add scanners for the two built-ins that lack usage — **opencode** and
  **gemini** — so all five built-ins are billable.
- Correct the stale "Gemini can't be tracked" claims in code comments, this
  repo's RFCs, and the doc site (en + zh).

## Non-Goals

- **No hook-sourced usage.** Usage stays after-the-fact transcript scanning; hook
  events do not carry token counts and the hook data flow is unchanged.
- **No `scanUsage` for `match` sources, and no auto-derivation.** `scanUsage` is
  an opt-in capability a source (a built-in, or a JS `handler`) implements. A
  no-code `match` source stays presence-only.
- **No pricing-pipeline change.** `src/usage/pricing.ts` (model-substring → USD,
  plus transcript-provided cost) is untouched; new scanners emit the existing
  `UsageRecord` shape and reuse the same buckets and pricing.
- No change to presence, providers, rendering, the state machine, or the source
  table's merge/override/disable semantics.

## Verified data

Re-verified before shipping (opencode against this machine's real DB; gemini
against the Gemini CLI source, since it is not installed here):

- **opencode persists per-message tokens AND a real cost.** opencode ≥1.2 stores
  SQLite at `~/.local/share/opencode/opencode.db`. The `message` table has one row
  per message with a `data` JSON column; assistant rows carry
  `{ role:"assistant", tokens:{ input, output, reasoning, cache:{ read, write } }, cost (USD float), modelID, providerID, time:{ created, completed } }`.
  Confirmed on this machine: `tokens.total === input + output + reasoning + cache.read + cache.write`
  holds for **all 1609 assistant messages (0 mismatches)** (e.g.
  `82462 = 480 + 464 + 2030 + 0 + 79488`), and `cost` is a real per-message float
  (e.g. `0.02104008`; 339 messages log `cost: 0`, which we keep). The row also has
  `id` and `time_created`/`time_updated` (epoch ms). Legacy (<1.2) fallback: JSON
  files at `~/.local/share/opencode/storage/message/{sessionId}/*.json` with the
  same per-message shape (not present on this machine, so exercised via fixtures).
  opencode logs a real cost, so we **trust it like pi** (never reprice).
- **Gemini CLI persists per-turn tokens** (no cost). Confirmed from
  `packages/core/src/services/chatRecordingService.ts`: the CLI automatically
  records sessions under `~/.gemini/tmp/<projectHash>/chats/` (honor
  `GEMINI_CLI_HOME`). Current format is **JSONL**: the first line is session
  metadata (`sessionId`, `projectHash`, `startTime`, `lastUpdated`), and each
  subsequent line is a message record `{ id, timestamp (ISO), type:"user"|"gemini",
  content, model?, tokens? }`. `recordMessageTokens` writes
  `tokens = { input: promptTokenCount, output: candidatesTokenCount, cached:
  cachedContentTokenCount, thoughts: thoughtsTokenCount, tool: toolUsePromptTokenCount,
  total: totalTokenCount }` onto the last `gemini` message. A legacy single-object
  `.json` form (`{ sessionId, …, messages:[…] }`) also exists. Since `promptTokenCount`
  already includes cached tokens (Gemini API semantics), uncached input =
  `input - cached`, mirroring how codex splits cached input.

## Proposed Design

### 1. `SourcePlugin.scanUsage` — an optional capability

`src/cli/hook-context.ts` gains an optional method on the one contract:

```ts
// src/usage/types.ts
export interface ScanWindow {
  /** Inclusive lower bound (epoch ms). */
  sinceMs: number;
  /** Exclusive upper bound (epoch ms). */
  untilMs: number;
  /** Transcript-root override, mainly for tests. */
  root?: string;
}

// src/cli/hook-context.ts
export interface SourcePlugin {
  id: string;
  resolveHookContext(payload: unknown, env?: StringEnv): SourceContext;
  /**
   * OPTIONAL. Scan this source's local transcripts for usage records in the
   * window. A source that implements it is billable; one that omits it has
   * presence only. After-the-fact and read-only; only ever invoked from the
   * `usage` command and the signature-badge refresh, never from the hook
   * write path.
   */
  scanUsage?(window: ScanWindow): Promise<UsageRecord[]>;
}
```

The existing scanners already have exactly this shape
(`(window) => Promise<UsageRecord[]>`, with an optional `root`). The current
`ScanOptions` type in `scan-claude.ts` is structurally identical to `ScanWindow`,
so it becomes an alias (`export type ScanOptions = ScanWindow`) — one shape, no
drift — and the three scanners slot in unchanged:

```ts
export const BUILTIN_SOURCE_PLUGINS: Record<string, SourcePlugin> = {
  codex:    { id: 'codex',    resolveHookContext: resolveCodexHookContext,    scanUsage: scanCodex },
  claude:   { id: 'claude',   resolveHookContext: resolveClaudeHookContext,   scanUsage: scanClaude },
  gemini:   { id: 'gemini',   resolveHookContext: resolveGeminiHookContext,   scanUsage: scanGemini },
  opencode: { id: 'opencode', resolveHookContext: resolveOpenCodeHookContext, scanUsage: scanOpenCode },
  pi:       { id: 'pi',       resolveHookContext: resolvePiHookContext,        scanUsage: scanPi }
};
```

`UsageRecord.source` (and `UsageTotals`/`SourceUsage` etc.) relax from the
`'claude' | 'codex' | 'pi'` union to `string`; `UsageSource = string`.

**Module-graph note.** `hook-context.ts` now references the scanners, so they
enter the hook path's import graph. This is cheap: the scanners have no top-level
side effects, and `read-jsonl.ts` only pulls `node:fs`/`node:readline`, already in
the usage path (and, via `usage-badge.ts`, already in the hook graph today). The
one landmine is `node:sqlite`, which does **not** exist before Node 22 while
`engines.node` is `>=20`; a static import would throw at load time and break the
hook. The opencode scanner therefore imports `node:sqlite` **dynamically inside
the function**, never at module top level (see §4). Separately, third-party
**handler** code is kept off the hook path by `billableSources`'s
`includeHandlers` flag (§2), not by the import graph.

### 2. Dynamic `collectWindowUsage` over the merged table

`src/sources.ts` exposes the billable subset of the merged table, in
**merged-table order** (the same order `config show` / `source list` present, and
the display order chosen for `usage`):

```ts
// src/usage/types.ts — leaf module, so both usage/ and sources.ts can name it
// without a cycle.
export interface BillableSource {
  id: string;
  scanUsage: (window: ScanWindow) => Promise<UsageRecord[]>;
}

// src/sources.ts
export interface BillableSourcesOptions {
  /**
   * Whether to resolve JS `handler` sources — which means `import()`ing
   * third-party code. The `usage` command passes `true`; the hook/badge path
   * passes `false` so no third-party module is loaded on the session-boundary
   * hot path (only first-party `builtin:` sources are scanned there).
   */
  includeHandlers?: boolean;
}

/** Merged-table sources that expose `scanUsage`, in table order. */
export async function billableSources(
  config: AppConfig,
  options?: BillableSourcesOptions
): Promise<BillableSource[]>;
```

**One resolution path, shared with presence.** `src/sources.ts` extracts a single
`resolveSourcePlugin(source, entry, { includeHandlers })` that both
`resolveHookContextForSource` (presence) and `billableSources` go through, so trust
is derived in exactly one place:

- `builtin:<id>` → `BUILTIN_SOURCE_PLUGINS[id]`, marked **trusted**.
- JS `handler` → the existing guarded, `pluginCache`-backed loader
  (`loadConfiguredSource` → `isConfigFileTrusted` / `resolveHandlerSpecifier`),
  marked untrusted.
- `match` → the no-code plugin (untrusted, but has no `scanUsage`, so it is skipped
  for billing).

Trust still follows the **`builtin:` marker, not the id** (a user who overrides a
built-in id with their own `handler` gets the guarded, credential-stripped path),
because `scanUsage` is read off the **resolved** plugin, never keyed by id.
`billableSources` keeps only entries whose resolved plugin implements `scanUsage`.
A JS `handler` can therefore be billable; a `match` source cannot (Non-Goals).

**Why `includeHandlers` matters (hook-path invariant).** The signature-badge
refresh (`refreshSignatureUsageBadges`) runs on the hook path at session
boundaries. The source-plugins RFC's invariant is that a hook loads **only the one
firing source**, never all of them. So the badge path calls
`billableSources(config, { includeHandlers: false })` — it scans the five
first-party built-ins (no `import()`) and never loads a third-party handler just to
probe for `scanUsage`. The standalone `agent-presence usage` command is the
interactive path and calls `billableSources(config)` (handlers included), so a
configured billable `handler` **does** contribute to `usage` but **not** to the
live signature badge. This asymmetry is deliberate and documented; it keeps the
hook data flow unchanged (Non-Goals) and third-party code off the hot path.

`collectWindowUsage` iterates that list instead of the hardcoded trio:

```ts
export interface CollectOptions {
  days: number;
  now: number;
  pricing?: PricingOverrides;
  /** Billable sources to scan, in display order (resolved once by the caller). */
  sources: BillableSource[];
  /** Per-source root overrides keyed by source id, mainly for tests. */
  roots?: Record<string, string>;
}

export async function collectWindowUsage(options: CollectOptions): Promise<WindowUsage> {
  const untilMs = options.now;
  const sinceMs = startOfLocalDayMs(options.now) - (options.days - 1) * DAY_MS;

  const perSource = await Promise.all(
    options.sources.map((source) =>
      // Fail-soft: one source's unreadable data must not break the whole run,
      // mirroring how presence resolution fails open. Logged (redaction-safe,
      // name only) rather than silent, since the scanners are already internally
      // tolerant of missing files/lines — a throw out of `scanUsage` is a real bug.
      source.scanUsage({ sinceMs, untilMs, root: options.roots?.[source.id] })
        .catch((error) => {
          void writeLog(`usage scan failed source=${source.id} error=${errorName(error)}`);
          return [] as UsageRecord[];
        })
    )
  );

  const bySource = options.sources.map((source, i) => summarise(source.id, perSource[i], options.pricing));
  return { sinceMs, untilMs, bySource, total: combineTotals(bySource) };
}
```

Callers resolve `billableSources(config)` once and pass it to every window:

```ts
// usage command (interactive): handlers included
const sources = await billableSources(config);
// badge refresh (hook path): built-ins only, no third-party import()
const sources = await billableSources(config, { includeHandlers: false });

const windows = await Promise.all(days.map((d) => collectWindowUsage({ days: d, now, pricing, sources })));
```

`summarise` groups by the **source id it called**, not by `record.source`, so a
mislabelled handler still lands under its declared id (`record.source` becomes
informational). The `roots` test seam is preserved (now keyed by source id
string). `pricing.ts` still decides cost: records with a real `costUsd` (pi,
opencode) keep it; the rest reprice by model substring, `null` when unknown.

### 3. `agent-presence usage` command

`src/cli/commands/usage.ts` stops hardcoding sources:

- Source rows come from `window.bySource` order (i.e. merged-table order); the
  `SOURCE_LABEL` map is **removed** — the row label is the source id itself
  (built-in ids already equal their labels, and a new/unknown id renders as its
  id rather than crashing on a missing label).
- The `gemini: not tracked …` footer line is removed (gemini is now tracked).
- `--json` output is unchanged in shape (`bySource` is still an array; entries
  are now dynamic).

### 4. New built-in scanners

Both emit the existing `UsageRecord` shape and are tolerant of missing
fields/files (fail-soft — a bad file yields fewer records, never a throw).

**opencode (`src/usage/scan-opencode.ts`).** Prefer SQLite; fall back to legacy
JSON; return `[]` when nothing is present.

- Data dir: `root ?? join(dataHome(), 'opencode')`, where `dataHome()` honors
  `XDG_DATA_HOME` and defaults to `~/.local/share`.
- SQLite: `await import('node:sqlite')` inside the function (guarded — Node <22 or
  a load failure falls through to legacy). Open the DB **read-only**, then
  `SELECT time_created, data FROM message WHERE time_created >= ?` (sinceMs),
  parse `data`, keep `role === 'assistant'`, and use `time.completed ?? time.created
  ?? time_created` as the record timestamp with a precise `[sinceMs, untilMs)`
  filter. (The row `id` is not selected — unlike gemini, opencode stores one row
  per message, so no dedup key is needed.)
- Missing DB **or** sqlite unavailable → try legacy JSON at
  `<dir>/storage/message/**/*.json`; missing that too → `[]`.
- Mapping (trust the logged cost, like pi): `inputTokens = tokens.input`,
  `outputTokens = tokens.output + tokens.reasoning` (reasoning is output-billed,
  and this keeps our four-bucket total equal to opencode's `tokens.total`),
  `cacheWriteTokens = tokens.cache.write`, `cacheReadTokens = tokens.cache.read`,
  `costUsd = data.cost` (even `0`), `model = data.modelID`.

**gemini (`src/usage/scan-gemini.ts`).** Reprice via `pricing.ts`, like codex.

- Root: `join(geminiHome(), 'tmp')`, where `geminiHome()` honors `GEMINI_CLI_HOME`
  and defaults to `~/.gemini`; `root` override targets that dir directly. Walk it
  recursively for `*.jsonl` (current) and `*.json` (legacy) chat files.
- JSONL: skip the metadata / `$set` / `$rewindTo` lines; keep `type === 'gemini'`
  message records that carry `tokens`. Legacy JSON: iterate `messages[]` the same
  way.
- **Dedup by message `id`, keeping the largest-total occurrence** — the CLI
  re-appends the same `gemini` message once tokens are attached, so a naive sum
  would double-count. (Same idea as the claude scanner.) Rewound turns still
  consumed tokens, so they are counted; `$rewindTo` is not replayed (documented
  simplification).
- Mapping (Gemini `input`/`promptTokenCount` already includes cached, mirroring
  codex): `inputTokens = max(0, tokens.input - tokens.cached)`,
  `cacheReadTokens = tokens.cached`, `outputTokens = tokens.output + tokens.thoughts`
  (thinking tokens are output-billed), `cacheWriteTokens = 0`, `costUsd = null`,
  `model = message.model`. `DEFAULT_PRICING` ships no gemini entry, so cost shows
  `n/a` until a user adds a `usage.pricing` override — the exact same behavior any
  unpriced claude/codex model already gets, and consistent with "pricing pipeline
  unchanged". Token counts are always exact.

## Alternatives Considered

- **Leave usage hardcoded, just add two `if` branches.** Rejected: it keeps the
  two-subsystem split the RFC is removing and repeats the union/order/`Promise.all`
  edit-in-three-places problem for the next agent.
- **Add a bundled SQLite dependency (better-sqlite3).** Rejected: the package ships
  one runtime dep (`@clack/prompts`) and leans on Node builtins; a native addon is
  a supply-chain and install-footprint cost. `node:sqlite` (dynamic, guarded) plus
  a legacy-JSON fallback covers the supported range without a new dep.
- **Auto-derive `scanUsage` for `match` sources.** Rejected (Non-Goal): a token
  log location/shape is not expressible as field mappings; billability is real
  code a source opts into.
- **Add gemini pricing to `DEFAULT_PRICING`.** Deferred: the task fixes the
  pricing pipeline as out of scope. Gemini tokens are exact and cost is overridable
  per deployment, exactly like any other unpriced model.

## Rollout Plan

- Additive and backward compatible: `scanUsage` is optional, so existing config /
  `match` / handler sources are unaffected; no config migration.
- `usage --json` keeps its shape (dynamic `bySource` array). The human table gains
  opencode and gemini rows.
- **Public API change:** `UsageSource` (re-exported from the package) widens from
  the `'claude' | 'codex' | 'pi'` union to `string`. Flag it in the changeset.
- **Tests migrate** (AGENTS.md: update tests when behavior changes): existing
  `collectWindowUsage` tests must pass an explicit `sources` list and override
  roots for **every** billable id they exercise, so a default run does not read the
  real `~/.gemini` / `~/.local/share/opencode` on the test machine. New scanner
  tests use fixture dirs.
- Ship with a changeset (minor): "usage now covers all five built-ins and any
  source-plugin that implements `scanUsage`".

## Risks

- **Node <22 has no `node:sqlite`.** Mitigated by the dynamic, guarded import and
  the legacy-JSON fallback; never imported at module top level, so the hook path
  is safe on Node 20/21.
- **Upstream format drift (opencode DB schema, gemini token shape).** Each scanner
  tolerates missing fields and unreadable files and degrades to fewer records,
  never a crash — the same posture as the existing scanners.
- **Handler `scanUsage` runs third-party code during `usage`/badge refresh.** Same
  trust model as handler `resolveHookContext` today (guarded load, cached, opt-in);
  a throwing handler is caught per-source and contributes nothing.
- **opencode/gemini token↔cost reconciliation.** We fold reasoning/thoughts into
  output and split cached out of input; totals match the vendors' own `total`
  within the `tool`-token rounding noted above.

## Review Notes

Cross-reviewed by subagents for (a) architecture / interface fit and (b)
correctness of the opencode and gemini transcript formats before implementation;
findings folded in.
