# Security Policy

## Reporting a Vulnerability

Do not report vulnerabilities by opening a public issue if the report includes secrets, exploit details, private infrastructure, or user-specific data.

For private reports, contact the repository owner directly through GitHub or use the repository security advisory flow if it is enabled.

Please include:

- affected version or commit
- operating system and runtime details
- reproduction steps
- expected behavior
- actual behavior
- impact assessment

## Sensitive Data

Do not include tokens, private keys, local credentials, internal hostnames, or personal filesystem paths in issues, pull requests, commits, logs, screenshots, or test fixtures.

Agent Presence stores provider credentials in Keychain by default, with environment variables as the explicit automation override. Credentials must not be embedded in hook commands, generated signature URLs, README examples, tests, or Changesets.

## Supply Chain

Repository package management uses the pinned pnpm version in `packageManager` and the safety settings in `pnpm-workspace.yaml`. CI uses frozen lockfile installs with dependency install scripts disabled, then runs tests, typecheck, build, and package dry-run explicitly.

Releases go through Changesets and npm Trusted Publishing. Do not add long-lived npm publish tokens to repository secrets for the default release path.
