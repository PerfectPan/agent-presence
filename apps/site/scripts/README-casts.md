# asciinema casts

The `.cast` files in `apps/site/public/casts/` are **hand-written, sanitized
asciinema v2 files** — they are NOT produced by recording a real terminal.
They replay read-only `agent-presence` commands with placeholder output, so the
site can show a terminal-style walkthrough without ever capturing credentials.

## Why hand-written (not recorded)

The task's security red line: **no real credentials/tokens/slot values may ever
appear in a recording or example**. The login and credential-entry flow is
interactive and would expose secrets, so it is deliberately NOT recorded. Only
read-only commands are shown, and their output uses placeholders.

## Cast inventory

| File | Command(s) replayed | Notes |
| --- | --- | --- |
| `public/casts/quickstart.cast` | `agent-presence --help`, `agent-presence status`, `agent-presence url` | `status`/`url` output uses placeholders: slot id `slot_xxx`, faas id `<faasId>`. |
| `public/casts/usage.cast` | `agent-presence usage`, `agent-presence usage --days 1 --json` | Token/cost figures are **illustrative** (2.1M · $4.50 mirrors the README's documented badge format), not from a real transcript. |

## Sanitization rules (enforced)

- slot id: always `slot_xxx` (never a real slot id)
- faas id: always `<faasId>` (never a real `record_id`)
- tokens/bearers: always `<token>`, never a real value
- timestamps in JSON: `<startOfLocalDay(now)>`, `<now>` placeholders
- token/cost numbers: illustrative, clearly labeled in the cast comment

## Asciicast v2 format

Line 1 is the header JSON. Each subsequent line is `[<seconds>, "<type>", "<data>"]`
where `type` is `"o"` (output) or `"i"` (typed input). `\r\n` ends each output
line so the terminal cursor behaves correctly.

## Regenerating from a real session (if you ever want live figures)

If you later record real output, **redact before committing**:

```bash
# Record only read-only commands in a throwaway shell with fake creds exported.
asciinema rec /tmp/raw.cast
# Then hand-edit the .cast: replace any real slot id / faas id / token with the
# placeholders above, and scrub any transcript-derived numbers unless intended.
```

Never commit a `.cast` that contains a real slot id, faas id, bearer, or token.
Run the credential scan from the repo root before pushing:

```bash
rg -n "slot_[a-zA-Z0-9]{12,}|rec_[a-zA-Z0-9]{12,}" apps/site/public/casts
```

It should return nothing (only `slot_xxx` / `<faasId>` placeholders exist).
