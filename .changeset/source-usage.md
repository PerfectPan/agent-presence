---
'@rivus/agent-presence': minor
---

Unify token/cost accounting under the source table: `SourcePlugin` gains an optional `scanUsage(window)` capability, so a source is one thing that declares all of its capabilities. A source that implements `scanUsage` is billable; one that omits it (any `match` source) contributes presence only.

`agent-presence usage` (and the signature usage badge) now iterate the merged source table's billable sources dynamically via `billableSources()` — through the same trust/resolution path as presence — instead of a hardcoded `claude/codex/pi` trio. A JS `handler` source can therefore be billable too; the hook/badge path never loads third-party handlers (`includeHandlers: false`).

All five built-ins are now billable. The three existing scanners (Claude, Codex, Pi) are wired onto their built-in `scanUsage` unchanged, and two new scanners are added:

- **opencode** — reads the local SQLite store (`~/.local/share/opencode/opencode.db`, with a legacy JSON fallback) via node's builtin `node:sqlite`, imported dynamically so Node <22 is unaffected; trusts opencode's logged per-message cost like Pi.
- **Gemini CLI** — reads the local chat transcripts (`~/.gemini/tmp/<hash>/chats/`, honoring `GEMINI_CLI_HOME`); priced from the table like Codex. This corrects the earlier, now-incorrect claim that Gemini keeps no local per-message token log.

`UsageSource` widens from the `'claude' | 'codex' | 'pi'` union to `string`. The pricing pipeline and the presence/source-table semantics are unchanged.
