---
'@rivus/agent-presence': patch
---

Run hooks directly with Node through the stable shim instead of invoking npx. Setup installs its exact published version under the presence home's `runtime/<version>/` directory, keeps the current and previous shim's runtimes, and removes all runtimes on uninstall. dsh and the macOS power watcher also use the shim. `--hook-command package` is the default, with `npx` retained as an alias; `absolute` continues to use the checkout CLI.

Upgrading from 0.10.0 only requires installing this release and running setup. The installed agent commands are unchanged, so no uninstall or additional hook re-trust cycle is needed.
