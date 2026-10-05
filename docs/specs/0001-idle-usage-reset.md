# Spec 0001: Idle Usage Reset At Midnight

Carries the unfinished follow-up of the retired Token Usage Statistics RFC. Token usage, calendar-day windows, and the local stale-badge guard are delivered and documented in [`docs/architecture.md`](../architecture.md#token-usage-scanusage).

## Status

Draft

Paired Plan: [`docs/plans/0001-idle-usage-reset.md`](../plans/0001-idle-usage-reset.md)

## Problem And Scope

The signature value is rendered and written only by the local CLI: on hooks, `update`, the deferred `flush`, and power-event `reset`. The renderer already replaces a usage badge whose calendar-day window has rolled over with `—`, but only when something re-renders. When the machine is idle, asleep, or off across local midnight, nothing writes, so the Feishu preview keeps showing the previous day's `今日` total until the next hook the following day.

In scope: the default `magic-builder` preview stops showing a usage figure from a window that has rolled over, without the local machine running.

Out of scope: the `feishu-signature` direct preview, which renders the slot value on a page this project does not control; changing how usage is collected or priced; changing local rendering, which already applies the stale guard.

## Behavioral Requirements

- When the published value contains a usage badge and no write has happened since the earliest local midnight at which the local renderer would mark one of its badges stale, the `magic-builder` preview must stop showing that value within one preview cache interval (`expire_strategy`, 60 seconds) and show the idle title instead.
- A published value without a usage badge has no such deadline and is shown as today.
- The idle title must not contain a usage figure.
- A value written after that midnight must be shown as today, exactly as today.
- Presence and usage collection, hook timing, and the slot write path must not change for installations that do not republish the preview function.
- No credential may leave the machine beyond what the published preview function already embeds.

## Domain Invariants

- A `今日` figure is never presented as today's total after the local day it was computed for has ended, on either the local render path or the published preview.
- The local machine remains the only writer of the presence value.

## Acceptance Examples

### S1: Idle across midnight

- Given the last write was at 23:50 local time with a `今日` badge
- And nothing writes after that
- When Feishu fetches the preview at 00:02 the next day
- Then the preview shows the idle title, with no usage figure

### S2: Activity after midnight

- Given the last write was at 23:50 local time
- When an agent hook writes a new value at 00:05
- Then a preview fetched at 00:07 shows that new value

### S3: Preview function from an older version

- Given a `magic-builder` preview function published before this change
- When Feishu fetches the preview after midnight
- Then it shows the slot value as it does today, and `agent-presence setup --skip-login` republishes the function with the new behavior

### S4: Direct preview unchanged

- Given the `feishu-signature` provider
- When Feishu fetches the preview after midnight
- Then the preview behaves exactly as before this change

## Compatibility And Constraints

- Public API: none.
- Persisted data: the slot backend must carry the deadline after which the current value is stale; the format is an open decision in the paired Plan.
- Configuration: none required; the idle title follows the existing `magic-builder` fallback title.
- Operational bounds: the preview cache interval bounds how late the reset becomes visible.

## Acceptance Evidence

- Scenario IDs and corresponding tests: not written yet.
- Runtime or package evidence: not available yet.
