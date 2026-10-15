---
'@rivus/agent-presence': minor
---

Add `doctor` to report harness hook and ledger problems and `inventory` to list the ledger revision, installed entries and pending operations. Both support `--json`. These commands prepare the harness integration; setup and uninstall still use the existing installers. Duplicate checks cover command-hook files, not opencode or Pi bridge files. `doctor` also reports `stale-path`, `unknown-event` and `timeout-unit` problems in other tools' hooks and exits 1 for them. `inventory` includes every kit application's entries in the shared ledger, not only presence's.
