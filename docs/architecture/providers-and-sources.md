# Providers, Sources, And Platform Integration

Provider abstractions, the merged source table and token-usage scanning (`scanUsage`), remote slot and Magic-Builder backends, and Linux credential and power-watcher integration. For the system overview and security boundaries, see [overview.md](overview.md).

## Provider Registry

`src/providers/types.ts` defines a capability-oriented `PresenceProvider` interface, and `src/providers/registry.ts` exposes `createProvider(id, { config, credential })`. CLI commands resolve a provider through the registry and call `assertSupports*` for the capability they need (login, publish, signature url) instead of importing a storage backend directly. This is the seam new providers plug into.

Capabilities are optional because not every provider supports every operation:

- `createQrCode` / `getLoginStatus` — login.
- `publishValue(value)` — push the rendered value to wherever the provider stores it.
- `getInfo()` — raw backend read for `status --remote`.
- `buildSignatureUrl()` — the link-preview URL the signature embeds.
- `getRemotePreview()` — a front-end provider's own server-rendered preview (magic-builder's FaaS output).

### Slot backend vs. provider

The two shipped providers are not independent backends: they read and write the **same** slot. That shared storage is modelled explicitly as a `SlotBackend` (`src/providers/slot-backend.ts`), implemented by `LGaryYangSlotBackend`. Both `feishu-signature` and `magic-builder` _compose_ the same `SlotBackend` for login/publish/info and differ only in the signature URL (and, for magic-builder, the `getRemotePreview` FaaS read). Neither provider depends on the other.

The capability layer is deliberately generic (`publishValue`, not `updateSlot`) so a future provider with its own, slot-unrelated storage can implement `PresenceProvider` directly and never touch `SlotBackend`. Its own credential model and login flow would be added alongside at that point; the registry seam itself does not change.

## Source Table

Sources (which agents feed presence) are modelled as a single **source table**, so first-party and third-party agents are handled uniformly. `src/cli/hook-context.ts` defines one `SourcePlugin` interface (`{ id, resolveHookContext(payload, env) }`) and keeps the seven built-in resolvers (`codex`, `claude`, `gemini`, `opencode`, `pi`, `grok`, `dsh`) as its reference implementations in `BUILTIN_SOURCE_PLUGINS`. Each entry also lists, as `scanEnv`, the environment variables that locate its transcripts (names from `SCAN_ENV`: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `GROK_HOME`, `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`), and the usage scan reads those variables only through these names. The table holds no scanner, so resolving a source loads no scanner module. `src/sources.default.json` ships a default table that lists those built-ins as `builtin:<id>` handlers.

`src/sources.ts` computes the **effective table** by merging the user's `config.plugins.sources` over the shipped defaults by id (`mergedSources`): a same-id entry **overrides** a built-in, a new id **adds** a source, and `enabled: false` **disables** one. `resolveHookContextForSource(source, payload, config)` then resolves an id from that table. Not writing a `plugins.sources` (or a given id) leaves the shipped default in effect. Downstream of context resolution the pipeline is already source-agnostic — `AgentSession.source` is a plain string, `renderDetails` groups by it verbatim, and `normalizeEvent` understands the PascalCase lifecycle events — so a source only needs to turn its hook payload into `{ sessionId, project, event }`.

A table entry resolves by kind:

- **`builtin:<id>`** — reuse the shipped in-code resolver. **Trusted** (first-party, ships with the package): receives the raw environment, since built-ins rely on env fallbacks.
- **Declarative `match`** — no code. Each of `sessionId` / `project` / `event` is a `pickString`-shaped field spec (`envKeys` / `payloadKeys` / `nestedPayloadKeys` / `payloadFirst`), so it reaches nested payloads and controls env-vs-payload precedence like a built-in.
- **JS `handler`** — an absolute path or npm specifier for an ESM module whose `default` export is a `SourcePlugin`. agent-presence `import()`s it in-process during a hook.

Trust follows the `builtin:` marker, not the id: a user who overrides `codex` with their own `handler` gets the guarded path. Because a `handler` runs in-process with full CLI trust (including credential access), loading is guarded: it is opt-in (shipped defaults are all `builtin:` and run no user code), the handler receives a **curated env** with credential-bearing keys stripped, an absolute-path handler is refused if it is a symlink / not owned by the current user / world-writable, and `handler` entries are ignored entirely if `config.json` itself is world-writable or not user-owned. Handler failures fail open — logged with non-secret fields only, degrading to an empty context — so a source can never break a hook. `agent-presence config show` prints the merged table as `sources`, each with its `origin` (`default`/`config`), `kind` (`builtin`/`handler`/`match`), and `overridesDefault` flag.

Source table invariants:

- `resolveHookContext` must be synchronous and do no I/O: it runs on the hook hot path. The framework cannot enforce that for a `handler`. Managed command hooks have an agent-side timeout, but asynchronous bridge delivery has no child-process timeout; the handler must honor the synchronous, no-I/O rule itself.
- A handler is imported lazily and cached per process. Each hook is a fresh short-lived process, so a handler is imported at most once per hook and only when its source fires; `builtin:` entries are static imports.
- A bare handler specifier resolves only from the plugins dir's `node_modules` (`createRequire` anchored there), never from the user's cwd or an ancestor `node_modules`. An absolute path is imported through `pathToFileURL` after the ownership checks above.
- The ownership checks `lstat` the handler file and its parent directory before `import()`. A same-user process can still swap the file between the check and the import; closing that window needs fd-based loading and is not done. The practical bound is that the operator owns the file and its directory and vets the code.
- A runtime `import()` bypasses the install-time supply-chain controls this repository applies to its own dependencies (frozen lockfile, the `allowBuilds` allowlist for dependency build scripts, `minimumReleaseAge`). Prefer absolute paths under a user-owned directory, and use an organization-reserved npm scope for bare specifiers to avoid dependency confusion.
- If `sources.default.json` is missing at runtime, `defaultSources()` falls back to the in-code built-in ids as `builtin:<id>`, so presence never silently stops counting first-party agents.
- Event names outside `normalizeEvent`'s vocabulary count as heartbeats; a `handler` or `match.event` should normalize them first.
- `setup` installs agent-side hooks only for the built-ins, and `help` lists only them. A configured source's agent side is delivered through that agent's own mechanism.

### Installing a source by package

`agent-presence source add <npm-package>` downloads a source-plugin package and registers it, so operators do not hand-edit config. It accepts only a plain registry spec (`pkg`, `pkg@range`, `@scope/pkg[@range]`); git, URL, tarball, `file:`, and `npm:` alias specs are rejected because their installed directory name would not match the recorded handler. It `npm install`s (via `execFile`, with `--ignore-scripts`) into an isolated plugins dir (`~/.agent-presence/plugins/`, override `AGENT_PRESENCE_PLUGINS_DIR`) so packages land under `<pluginsDir>/node_modules`, never in the CLI's own install; use `--registry` (or `AGENT_PRESENCE_REGISTRY`) for an internal registry. It then validates the package exports a real `SourcePlugin`, and records `plugins.sources.<id> = { handler: "<packageName>" }` — the merged table stays the one source of truth. At hook time a bare specifier resolves from the plugins dir via `createRequire`. `source list` prints the merged table; `source remove <id>` unregisters and (unless `--keep-package`) uninstalls the package; `uninstall --all` removes the whole plugins dir. Because `add` downloads and runs third-party code in the credential-bearing process, it prints a trust notice and requires `--yes` or an interactive confirmation.

### Token usage (`scanUsage`)

Token/cost accounting is a **capability of the same source table**, not a separate subsystem: a source that contributes usage is billable; a `match` source contributes presence only. `billableSources(config)` (`src/usage/billable-sources.ts`) enumerates the merged table's billable sources, in table order, through the **same** trust/resolution path as presence (`resolveSourcePlugin` in `src/sources.ts`: `builtin:` → the built-in's usage capability; JS `handler` → the guarded, cached loader and its own `scanUsage`; `match` → skipped). Only the `usage` command and the signature-badge refresh import that module, so the hook path reaches no scanner. `collectWindowUsage()` iterates that list — no hardcoded source set — so `agent-presence usage` and the signature badge both cover every billable source dynamically. Usage stays **after-the-fact transcript scanning** (ccusage-style), independent of the hook payload; hook events never carry token counts.

Every built-in except `dsh` is decoded by `@rivus/agent-kit/transcript/usage`: `billableSources` marks each with its kit agent id — the mapping lives in one place, `KIT_AGENT_BY_SOURCE` in `src/usage/kit.ts` (`claude` → `claude-code`, `gemini` → `gemini-cli`, `codex`, `opencode`, `pi`, `grok` identity) — and one stateless `scanUsage(platform, { agents, since, until })` call per window decodes them together, read from the platform's environment (the agent-home variables of `SCAN_ENV`, which the kit's home rules resolve; a set `GEMINI_CLI_HOME` moves the Gemini root to `$GEMINI_CLI_HOME/.gemini/tmp`, matching Gemini CLI's layout). Every scan re-reads the whole window and replaces that window's per-source snapshots; no scan state is kept, so overlapping scans are idempotent and a price change applies on the next scan. A custom JS `handler` source keeps its own `scanUsage`, and dsh keeps its own usage-log reader; their records (four buckets, input excluding the cache) are converted to the kit record shape at the totals boundary (`toKitRecord` in `src/usage/kit.ts`), so one summarizer serves every source. Records are grouped under the id of the source that was scanned; a configured entry reusing a built-in (`handler: "builtin:claude"` under another id) reports the same contribution as the built-in's own entry, exactly as per-source scans did.

Signature accounting keeps a per-window, per-source snapshot in state. Same-day session-boundary events owe a refresh of only the contribution owned by their source (`opencode` scans opencode, `codex` scans Codex, and so on), which the worker's follow-up lane scans, and then the renderer aggregates the configured source snapshots. The worker scans with its own environment except for the agent-home variables: every variable in `SCAN_ENV` is set to the value the boundary recorded, or unset when none was recorded, whichever source the refresh scans — so a promoted first-boundary refresh reads no home variable the producer did not copy, and a source whose variable was not recorded reads its default root under the worker's home until its own boundary records one. Two paths work off a refresh: the worker's follow-up lane and `worker --stop`'s takeover scan through the recorded environment above; the standalone `usage` command and `update`'s explicit full refresh run in the user's shell and read that environment instead (`flush`, `status`, and `reset` work off no refreshes at all). This prevents one agent's lifecycle event or scanner version from recalculating another agent's ledger. The first source boundary after midnight, or the first boundary when no aggregate timestamp exists, is the deliberate exception: that refresh fills what the day lacks — it scans its own source plus every built-in that has no snapshot from this day and no owed refresh entry bounded on this day (such an entry scans its source with its own recorded environment and time), giving inactive sources a current-day zero contribution so they cannot block the aggregate indefinitely, and never overwriting a snapshot it did not scan. An explicit `agent-presence update` also scans and replaces the complete built-in snapshot set; deferred flushes and power-event resets only re-render the cache. The slot sync computes, next to the staleness check, the deadline of the value it publishes: the earliest local midnight at which a non-stale badge actually visible in the selected template (within the 200-character limit) turns stale, carried on the update decision and saved locally with the successful published value (`usageResetDeadlineMs`). Calendar-date arithmetic keeps this at local midnight across DST changes. Loading and subsequent saves preserve the deadline; an explicit value or a render without badges clears it on success, while a failed publish preserves the preceding value and deadline. A refreshed badge with equal text but a different deadline still requires sync, and an in-flight sync does not settle a newer deadline, so a future transport to the generated preview can fall back at that midnight without a local write. No transport ships yet; the fallback title a generated preview shows already drops the `{usage*}` tokens, so a template that owns its usage label cannot fall back to a raw token. A signature refresh is atomic across its configured windows and sources: if any scan fails, the previous cache remains intact for the next boundary to retry. A refresh also takes an abort signal: aborted before or while its scans run, it stops waiting for them, leaves the cache as it was, and reports that it did not complete. Once the scans have finished, an abort no longer stops it: it waits for the state lock, saves, and reports completion, as it does after a failed scan. Overlapping refreshes merge snapshots monotonically by scan time, so a slower older scan cannot overwrite newer usage. During migration from a legacy cache that already has a current aggregate timestamp but lacks some window snapshots, a partial source refresh preserves the previous badge and timestamp until every configured source has a compatible snapshot; it never presents a partial or cross-day value as the total.

A trust detail survives from the scanner table: **the hot path stays first-party and source-scoped within a calendar day.** The signature-badge refresh calls `billableSources(config, { includeHandlers: false })`, then same-day hooks select only their own built-in source and never `import()` a third-party `handler` to probe for `scanUsage`. The first boundary after midnight fills the built-ins the day lacks, and an explicit update scans all built-ins. The standalone `usage` command is interactive and includes handlers.

Decoding corrections the kit adopts, each fixture-tested (`test/usage-kit-scan.test.ts`): Codex reads each rollout's own `thread_settings_applied` service tier and prices its records with the priority multiplier (`2`) per record, and from its first `token_usage_record` counts per-record usage, skipping unchanged `token_count` totals; Gemini CLI counts a migrated chat only once, from its `.jsonl` file, and adds tool-use prompt tokens to the input; Claude Code keys a turn by `requestId` (falling back to the message id when a gateway recorded none) and keeps, per request, the occurrence with the most tokens; Pi skips the copied parent entries at the start of a forked session; a count a transcript does not report stays absent instead of `0`.

Each decoder finalizes on its own schedule, and none of it depends on scan state: a Claude Code request stays unreported until four newer requests have been written in its conversation lane or the source has been quiet for 30 minutes; an opencode database message without a completion time counts once it completes or the database goes quiet for 30 minutes; the Gemini CLI, Pi, and Codex decoders count a request as soon as its record is complete. On the badge this lag compounds with the refresh rule: the worker scans at the boundary's time and, within a day, only the boundary's own source, so the requests Claude Code still held at the day's last boundary for that source count only at that source's next boundary more than 30 quiet minutes later — when there is none, the badge leaves them out for the rest of the day (the standalone `usage` command, which scans to the current time, reports them sooner). This under-report is accepted product behavior, not worked around.

Cost semantics go through the kit (`@rivus/agent-kit/cost`): a per-message cost an agent logged (Pi, opencode, Grok) wins as-is, unmultiplied, even `0`; otherwise each token count is charged at the model's price and the result is multiplied by the record's billing-tier multiplier; an unknown model has no cost and renders `n/a` while its tokens stay exact. Totals follow the kit record convention — `inputTokens` includes cache reads and writes, `outputTokens` includes reasoning, and the badge total is `inputTokens + outputTokens` — with one reporting difference: presence's `SourceUsage` rows and the `usage --json` fields keep `inputTokens` as the input that was neither read from nor written to a cache (the kit's input minus its cache counts), while a kit record itself carries the cache-inclusive input; `totalTokens` is the kit's two-bucket sum, the number the badge renders. The price table is the kit's LiteLLM snapshot (`litellmPrices` from `@rivus/agent-kit/cost/prices`): the chat models of the providers the agents call first-party, keyed by bare model name, refreshed by the kit weekly and updated here with the kit version. `createPricing` (`src/usage/pricing.ts`) resolves in the order user `config.usage.pricing` overrides (the longest key the id contains), then the table (the id itself, or the id without a date suffix or a `<provider>/` prefix), then presence's fallback aliases (the longest alias the id contains). The aliases price ids the table does not name. The table's own undated Claude, GPT-5 and DeepSeek V4 models are aliases at their table prices, so a suffixed variant (`gpt-5.5-codex`, `gpt-5.6-high`, `claude-opus-4-8-thinking`, `claude-sonnet-5[1m]`, Bedrock's `us.anthropic.claude-haiku-5-5-v1:0`) takes the price of the longest model its id contains, not a shorter model's. The Claude family aliases (`opus`, `sonnet`, `haiku`) charge the table price of `claude-opus-4-8`, `claude-sonnet-4-6` and `claude-haiku-4-5` to a Claude id that contains no tabled model. Models the table does not name, Claude Opus 4 (`claude-opus-4-20250514`), Opus 4.1, Claude 3 Opus and `gemini-3-pro-preview`, keep their last list prices instead of the `opus` alias's third of them. Bare `gpt-5` is not an alias and there is no GPT-5 family alias, because GPT-5 minor versions differ in price up to fourfold; an unlisted version such as `gpt-5.7` renders `n/a` until the kit's table names it. The model aliases have one accepted cost: a new model whose name extends a tabled one, such as `claude-opus-5-6` or `gpt-5.10`, takes the older model's price until the kit's table names it. A partial override takes its missing rates from the id's own price, and an id without one stays unpriced.

Windows are calendar days in the host's local time: a `days`-day window is `[startOfLocalDay(now) - (days - 1) days, now)`, so `今日` only grows during a day and resets at midnight instead of sliding like a rolling 24 hours. `collectWindowUsage()` scans the sources in parallel — the kit-decoded built-ins through their one shared call — and fails soft per source: a scan that throws is logged by source id and error name only and contributes nothing, so one unreadable store never breaks the report. A per-file decode failure skips only that file's contribution; the records the kit yielded before the failure stay valid. Unlike the previous scanners, the kit does not fall back from an unreadable `opencode.db` to the legacy JSON message store — a database that exists but cannot be read leaves opencode's contribution empty.

In the signature, `{usage}` (the default window) and `{usage_Nd}` (for example `{usage_1d}`, `{usage_7d}`) are render variables backed by the per-window cache in state; `usage.showInSignature` appends the default window without a template change. The cache is refreshed only on session-boundary events (start and finish, excluding subagent boundaries), which owe a `usageRefresh` entry the worker works off; other events reuse it. The signature therefore shows usage as of the last boundary rather than the live in-progress count; the standalone `usage` command always rescans. A cached badge whose window has fully rolled over (`今日` after one local midnight, `近N天` after N) renders as `—` instead of a number from a stale day, but only when something re-renders: an idle machine keeps the last published value until the next write ([issue #133](https://github.com/PerfectPan/agent-presence/issues/133) tracks resetting it remotely).

## Provider

`src/providers/l-garyyang.ts` implements the first slot backend:

```http
GET  /api/slot/wechat/qrcode
GET  /api/slot/wechat/login-status?sceneId=...
POST /api/slot/update
GET  /api/slot/info
```

The Feishu signature stores a link like:

```text
https://l.garyyang.work/?t2=<base62({{slot id="slot_xxx"}})>
```

The URL references the slot helper only. It must not contain tokens, local state, or machine-specific paths.

## Magic-Builder Provider

`src/providers/magic-builder.ts` is a second provider id, `magic-builder`. It does not replace `feishu-signature`; it is an alternate **front-end for the signature URL** that keeps the same l.garyyang slot as the value store.

**Why it exists.** The `feishu-signature` URL is an `l.garyyang.work` HTML page that renders inside Feishu's personal-signature link preview via an iframe. When Feishu tightens what that preview surface will render (e.g. an iframe-host whitelist change), the `l.garyyang.work` URL can stop displaying even though the slot value is still correct. `magic-builder` re-fronts the same value through `magic.solutionsuite.cn`, whose link-preview pipeline Feishu accepts, without changing how presence is computed or written.

**How it works.**

```text
hooks -> l.garyyang slot (unchanged write path)
                 ^
                 | GET /api/slot/info  (fetched on each preview refresh)
magic-builder FaaS  (published once to magic.solutionsuite.cn/api/faas)
                 ^
                 | Feishu pulls the link preview
signature URL = https://magic.solutionsuite.cn/r?fid=<record_id>
```

Setup renders a small CommonJS link-preview FaaS (`buildFaasCode`), `POST`s it to `magic.solutionsuite.cn/api/faas`, and persists the returned `record_id` under `providers.magic-builder.faasId` in `config.json`. Re-running setup `POST`s with the same `id` to update the function in place (idempotent). The FaaS returns the Feishu `url.preview.get` shape:

```json
{ "inline": { "i18n_title": { "zh_cn": "<current slot value>" } }, "expire_strategy": "60s" }
```

The FaaS reads only the slot's id and value, so it shows the last written value however old it is. When the slot read fails or the value is empty, it returns the fallback title fixed at publish time: `AGENT_PRESENCE_MAGIC_BUILDER_FALLBACK_TITLE`, else `providers.magic-builder.fallbackTitle`, else the `render.zero` template as written (its `{usage*}` tokens are not substituted), else `AI 牛马暂未开工`.

`expire_strategy` is the finest magic-builder cache granularity (60s). Combined with the writer-side debounce and Feishu's own client-side preview cache, the user-visible refresh is minute-scale, not real-time — adequate for an "agents currently working" indicator.

**Token acquisition (onboarding).** Publishing to `/api/faas` requires a magic-builder token, which is tied to the user's Feishu identity (the service authenticates through Feishu SSO). The CLI cannot bootstrap it headlessly. Resolution order is `MAGIC_TOKEN` env → OS keyring (`agent-presence:magic-builder`) → `~/.magic-token` → `<cwd>/.magic-token`. In an interactive terminal with no token, setup prints the acquisition steps (open the 妙笔 Feishu bot, send `dev`, copy the reply) and prompts for the token, then stores it in the keyring via the generic secret store. The plaintext `~/.magic-token` file is read for skill-pack compatibility but is never written by this CLI. The token prompt is gated behind the l.garyyang credential check: magic-builder needs an existing slot to read from, so a user must `login --provider feishu-signature` before the token prompt appears.

**Trust-boundary trade-off.** The published FaaS embeds the user's l.garyyang slot bearer so it can call `GET /api/slot/info` on each preview refresh. This sends a credential across the trust boundary to `magic.solutionsuite.cn`, which is why publishing requires explicit operator action rather than running unattended. It is accepted because the FaaS is private to the publisher's own magic-builder account and the slot bearer is low-sensitivity (read/write of one presence slot, no account access). Rotating that bearer requires re-running `setup --provider magic-builder` to re-publish. A future iteration could remove the embedded bearer by having l.garyyang expose an unauthenticated read-only slot endpoint, or by moving the value store to a Feishu bitable the FaaS reads with its own injected token.

## Linux Credential Storage

On Linux, the priority order for credential resolution is:

1. **Environment variables** — same cross-platform env vars as macOS (`AGENT_PRESENCE_TOKEN`, `AGENT_PRESENCE_SLOT_ID`, etc.).
2. **libsecret** (`secret-tool` CLI) — stores credentials in the system keyring (e.g., GNOME Keyring, KDE Wallet). Uses `service=agent-presence`, `account=token` and `account=slotId` attributes.
3. **Reject** — if neither env vars nor `secret-tool` is available, the CLI bails with a clear error instructing the user to install `gnome-keyring` or `libsecret-tools`.

Credentials are never written to `config.json`.

## Linux Power Watcher

On Linux, agent-presence skips the power watcher. Systemd user services and logind D-Bus signals are not reliably available across distributions for the suspend/resume/lock/unlock lifecycle that the macOS LaunchAgent covers.

The setup command outputs:

```
agent-presence: skipping power watcher on linux
  (no reliable systemd/logind path); TTL pruning still covers expired sessions.
```

TTL pruning (3-minute default) handles most failure modes (agent crashes, hard kills, terminal closures). The gap a watcher would close is a suspend that ends before the TTL expires, which is rare because suspends usually outlast three minutes.

A Linux watcher would be a systemd user unit subscribed to logind's `PrepareForSleep`, `Lock`, `Unlock`, and `SessionRemoved` signals, running `agent-presence reset --force --silent`. It is not shipped because the session D-Bus is missing in headless, SSH, and container sessions (a watcher that fails silently there is worse than none), some distributions disable the systemd user instance or need `linger`, unit search paths and signal semantics differ across distributions, and testing it would multiply the test matrix. Reconsider it when systemd user instances and a D-Bus client (`busctl` or `gdbus`) are reliably present on the distributions users run, install and uninstall reduce to copying a unit into `~/.config/systemd/user/` plus `systemctl --user enable`, and suspend/resume and lock/unlock can be tested on at least two major distributions.
