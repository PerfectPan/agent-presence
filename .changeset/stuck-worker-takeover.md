---
'@rivus/agent-presence': minor
---

Dedicated workers now run a watchdog that terminates only its own process when the main thread has been unresponsive for 90 seconds and a command is waiting. Commands never send signals to pids from heartbeat files and never terminate other commands. Heartbeats run independently of long asynchronous work; release stops the monitor and removes metadata before unlocking. A command allows one bounded recovery interval after its normal lock wait. Older workers, suspended processes and hung asynchronous operations with responsive event loops still require manual recovery.
