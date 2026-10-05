# Idle Usage Reset At Midnight

- Status: blocked
- Owner: unconfirmed
- Reviewer: unconfirmed
- Last updated: 2026-10-05
- Paired Spec: [`docs/specs/0001-idle-usage-reset.md`](../specs/0001-idle-usage-reset.md)

## Contents

1. Background and goals
2. Outline
3. Execution plan
4. Risks, open questions, and follow-up

## 1. Background and goals

### 1.1 Current behavior and constraints

- `src/render.ts` replaces a usage badge with `STALE_USAGE_PLACEHOLDER` (`—`) once `calendarDaysBetween(computedAt, now) >= days`, using the host's local midnight (`src/time.ts`). This only runs when the CLI renders.
- The `magic-builder` preview function (`buildFaasCode` in `src/providers/magic-builder.ts`) runs on every Feishu preview fetch, independent of the laptop. It reads the slot through `GET /api/slot/info`, which returns `slots: [{ id, value }]` with no timestamp, and falls back to `fallbackTitle` (`magicBuilderFallbackTitle`, which defaults to the `zero` render template) when the read fails or the value is empty.
- Both providers write the same l.garyyang slot through `SlotBackend`, and the `feishu-signature` page renders that slot value verbatim.
- The preview function is republished only by `agent-presence setup`; existing users already rerun `setup --skip-login` after upgrades that change persistent artifacts.

### 1.2 Problem

The validity of the published value is known only on the writer, and nothing carries it to the preview function, so an idle machine leaves yesterday's `今日` total in the signature.

### 1.3 Goals and success criteria

- Spec 0001 scenarios S1-S4 pass: S1-S3 as unit tests of the generated function with a stubbed `fetch` and clock, S4 as an unchanged-output test of the `feishu-signature` URL and slot write.
- The hook path does no extra network request: the deadline is written in the same slot sync as the value, or in one request that the deferred flush already owns.

### 1.4 Non-goals

- A scheduled writer.
- Changing the `feishu-signature` page.

## 2. Outline

### 2.1 Boundaries and responsibilities

The renderer already knows each badge's window and compute time, so it computes the deadline: the earliest local midnight at which `isUsageStale` would turn true for a badge in the value, as an absolute epoch. The slot sync publishes the deadline with the value. The preview function compares the deadline with its own clock, so it needs no timezone.

### 2.2 Design decisions

| Decision                                  | Options                                                                      | Choice                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Which clock decides midnight              | Fixed Asia/Shanghai vs host local time                                       | Host local time, the same rule as the calendar-day windows and the local stale guard      |
| Who computes the deadline                 | Preview function vs writer                                                   | Writer, as an absolute epoch, because only the writer knows the windows and compute times |
| What the preview shows after the deadline | A hard-coded idle line vs `fallbackTitle`                                    | `fallbackTitle`, which already follows the user's `zero` template                         |
| Where the deadline travels                | A second metadata slot / a marker inside the slot value / a scheduled writer | **Unresolved**, see section 4                                                             |

## 3. Execution plan

Blocked until the transport decision in section 4 is made.

### 3.1 Preconditions

- Spec 0001 reviewed.
- Transport decision recorded here, with evidence from the slot service for the chosen option.

### 3.2 Completion contract

- S1-S4 each have a test under `test/`.
- `pnpm test`, `pnpm run typecheck`, `pnpm run build` pass.
- A changeset tells existing `magic-builder` users to rerun `agent-presence setup --skip-login` to republish the preview function.
- `docs/architecture.md` describes the deadline in the Magic-Builder Provider section, and this Spec and Plan are deleted.

### 3.3 Execution order

#### Task 1: Deadline from the renderer

- Files: `src/render.ts`, `src/time.ts`.
- Change: compute the deadline next to `isUsageStale` from the windows the value references; no deadline when the value has no usage badge.
- Tests: deadline for `{usage_1d}`, for `{usage_7d}`, for both (earliest wins), and for no badge.
- Exit condition: render tests pass.

#### Task 2: Publish and honor the deadline

- Files: the slot sync path (`src/cli/slot-sync.ts`, `src/cli/rendered-slot-sync.ts`), `src/providers/slot-backend.ts`, `src/providers/magic-builder.ts`.
- Change: publish the deadline through the chosen transport; make the generated preview function return `fallbackTitle` when `now >= deadline`, and keep today's behavior when no deadline is present.
- Tests: S1, S2, S3 against the generated function; S4 against the `feishu-signature` URL and the published slot value.
- Exit condition: the scenario tests pass.

### 3.4 Validation ledger

| Batch | Command or evidence                                                            | Expected result |
| ----- | ------------------------------------------------------------------------------ | --------------- |
| 1     | `pnpm test`                                                                    | pass            |
| 1     | `pnpm run typecheck`                                                           | pass            |
| 1     | A republished preview function fetched after local midnight on an idle machine | idle title      |

### 3.5 Rollback per batch

One PR; revert it and rerun `setup --skip-login` to republish the previous preview function. A leftover deadline is ignored by the previous function.

## 4. Risks, open questions, and follow-up

| Item                                                                                                                                                                                                                                                                                                                                                                                        | Type          | Impact                                             | Owner       | Next step or deadline                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| Where the deadline travels: a second slot on the same l.garyyang account (unconfirmed whether an account can hold and write more than one slot), a marker inside the slot value (the `feishu-signature` page would render the marker, breaking S4), or a scheduled writer (a FaaS timer, unconfirmed on magic-builder, or an external cron that would copy the slot bearer off the machine) | open question | Blocks the plan                                    | unconfirmed | Confirm the slot service and FaaS platform capabilities              |
| A `zero` template that contains `{usage*}` tokens becomes a `fallbackTitle` with unrendered tokens                                                                                                                                                                                                                                                                                          | risk          | The idle title shows a raw `{usage_1d}`            | unconfirmed | Decide whether setup renders the fallback title without usage tokens |
| Preview function and writer disagree on the clock                                                                                                                                                                                                                                                                                                                                           | risk          | The reset shows up early or late by the clock skew | unconfirmed | Accept: the bound is the 60-second cache interval plus skew          |
