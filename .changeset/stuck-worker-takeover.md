---
'@rivus/agent-presence': minor
---

A command whose 10-second wait for the worker lock runs out now recovers a stuck holder without a manual kill: the holder beats (`<state>.worker.v.beat`, written when it takes the lock and after every finished iteration), and a holder whose beat is at least 90 seconds stale is signaled to leave (SIGTERM, SIGKILL after 2 seconds) so the command can take the lock the kernel frees. A holder that beats, or one without a readable beat, is left alone and the command fails as before.
