---
"@rivus/agent-presence": patch
---

Align docs with the magic-builder default provider and calendar-day usage windows.

- `docs/architecture.md`: the Configuration section still listed `feishu-signature` as the current provider id and the Magic-Builder section framed it as a non-default alternate; both now reflect that `magic-builder` is the default preview front-end while presence values are still always written to the `feishu-signature` slot.
- `README.md`: the Token Usage render-variable table and session-boundary refresh note still said "rolling" windows; updated to the calendar-day wording already used in the rest of the section.
- `README.zh-CN.md`: the Token Usage section was missing entirely; added a full translation that matches the English calendar-day semantics, render variables, and stale-badge guard.
