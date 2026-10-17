---
'@rivus/agent-presence': patch
---

Run hooks directly with Node through the stable shim instead of invoking npx. Setup installs its exact published version under the presence home's `runtime/<version>/` directory. `--hook-command package` is the default, with `npx` retained as an alias; `absolute` continues to use the checkout CLI. Invalid modes fail before install planning with a one-line error. Successful setup prunes under the runtime lock, keeping its version and the versions selected by the previous and current shim, and removes unused versions and leftover `runtime/.install-*` directories. Uninstall removes all runtimes.

dsh and the macOS power watcher also use the shim. Setup automatically rewrites an already-installed presence dsh plugin, recognized by its marker, to use the shim without prompting, including with `--yes` or in a non-interactive terminal. Only a fresh dsh plugin install asks for confirmation and is offered only when dsh is detected in an interactive terminal.

Upgrading from 0.10.0 only requires installing this release and running setup. The installed agent commands are unchanged, so no uninstall or additional hook re-trust cycle is needed.
