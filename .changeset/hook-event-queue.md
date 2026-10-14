---
'@rivus/agent-presence': minor
---

Hooks now record each event in a durable queue and return immediately; a background `agent-presence worker` applies the recorded events, runs the follow-up work, and publishes, so a hook no longer takes locks or waits on the network. The state-changing commands (`status`, `reset`, `flush`, `update`) take over from the worker and apply what is pending first; their printed output is unchanged. Because the hook runtime changes, upgrading to this version requires uninstalling the previous release with its own `agent-presence uninstall` before installing this one, and downgrading requires `agent-presence worker --stop` first (then the previous release's `setup`).
