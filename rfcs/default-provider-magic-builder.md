# RFC: Make `magic-builder` the Default Provider

## Status

Accepted

## Problem

The signature output has two providers:

- `feishu-signature` — stores the rendered value in an `l.garyyang.work` slot and
  embeds a `l.garyyang.work/?t2=…` link-preview URL in the Feishu signature.
- `magic-builder` — publishes a FaaS on `magic.solutionsuite.cn` that, on each
  Feishu preview fetch, reads the **same** l.garyyang slot value and returns it as
  the preview title; the embedded URL is `magic.solutionsuite.cn/r?fid=…`.

`feishu-signature` was the default (`DEFAULT_PROVIDER_ID = 'feishu-signature'`),
but in practice Feishu's link-preview pipeline does not reliably render the
`l.garyyang.work` page (it can tighten the iframe whitelist for personal-signature
previews), so the preview silently fails to update. `magic.solutionsuite.cn` is
accepted by that pipeline, so the magic-builder front-end is the reliable path —
yet new users had to discover it and opt in explicitly. The README also documented
only `feishu-signature`.

## Goals

- Make `magic-builder` the default provider so a bare `agent-presence setup` /
  `url` / `status` targets the reliable preview path.
- Keep `feishu-signature` fully supported as the underlying slot backend and as a
  direct-preview alternative (`--provider feishu-signature`).
- Update the README to lead with magic-builder and reframe feishu-signature.

## Non-Goals

- Changing where slot values are stored. Updates continue to flow to the
  l.garyyang slot via `feishu-signature`; magic-builder is only a preview layer.
- Removing or deprecating `feishu-signature`.
- Auto-acquiring the Magic-Builder token.

## Proposed Design

- Flip `DEFAULT_PROVIDER_ID` to `'magic-builder'`. `providerId()` already accepts
  it and maps the legacy `l-garyyang` alias to `feishu-signature`.
- No change to the hook/update push path: `hook` and `update` construct an
  `LGaryYangProvider` directly and write the l.garyyang slot regardless of the
  default, so presence keeps flowing. The default only changes which preview the
  provider-aware commands (`setup`, `url`, `status --remote`) assume.
- `login` is already provider-agnostic (always l.garyyang QR login), so
  `setup` with the new default still performs the QR login, then publishes the
  magic-builder FaaS (prompting for the Magic-Builder token).
- Both `url` (magic-builder) and `status --remote` degrade gracefully when no
  FaaS has been published yet, pointing the user at `setup`.

## Alternatives Considered

- **Docs-only: recommend magic-builder but keep the code default.** Rejected:
  the bare-command default would still produce the unreliable l.garyyang preview,
  so the out-of-box experience stays broken.
- **Drop `feishu-signature`.** Rejected: magic-builder depends on the l.garyyang
  slot for storage and login, and the direct preview is still useful where it
  renders.

## Rollout Plan

- Minor release. Existing installs are unaffected: `login` persists an explicit
  `provider` in `~/.agent-presence/config.json`, so the new default only applies
  to fresh setups with no provider configured.
- README (EN + zh-CN) updated to present magic-builder as the default and
  document the Magic-Builder token flow; feishu-signature documented as the
  underlying backend and direct-preview alternative.

## Risks

- **New users now need a Magic-Builder token** for the default path (in addition
  to the l.garyyang login). Mitigated by the in-setup prompt with instructions
  and the documented `--provider feishu-signature` escape hatch that needs no
  token.
- **A published FaaS is required before `url` resolves.** Mitigated by the
  existing "run setup first" error and graceful `status --remote` degradation.
