export function printHelp(): void {
  console.log(`agent-presence

Usage:
  agent-presence login [--provider <magic-builder|feishu-signature>]
  agent-presence setup [--provider <magic-builder|feishu-signature>] [--login] [--skip-login] [--hooks-only] [--no-hooks] [--yes] [--hook-command <package|npx|absolute>] [--agents <id,...>]
  agent-presence uninstall [--credentials] [--all]
  agent-presence url [--provider <magic-builder|feishu-signature>]
  agent-presence config show
  agent-presence config provider feishu-signature [--base-url <url>] [--preview-base-url <url>] [--image-key <key>] [--target-url <url>] [--reset]
  agent-presence config render [--zero <template>] [--one <template>] [--many <template>] [--reset]
  agent-presence source list
  agent-presence source add <npm-package> [--id <id>] [--registry <url>] [--yes]
  agent-presence source remove <id> [--keep-package]
  agent-presence status [--provider <magic-builder|feishu-signature>] [--remote]
  agent-presence doctor [--json]
  agent-presence inventory [--json]
  agent-presence usage [--days <n>] [--json]
  agent-presence update [--provider <magic-builder|feishu-signature>] [--force] [--value <text>] [--silent]
  agent-presence reset [--provider <magic-builder|feishu-signature>] [--force] [--silent]
  agent-presence hook --agent <claude-code|codex|gemini-cli|grok|opencode|pi>
  agent-presence hook --source <id> --event <name> [--silent]

Setup installs hooks for detected agents. --agents overrides detection with
claude-code,codex,gemini-cli,grok,opencode,pi. Setup installs the --agent form.
Direct hook calls use --source with claude, codex,
gemini, grok, dsh, or a configured source, and an internal event name such as
SessionStart, Heartbeat, or Stop.
The default hook-command mode is package: setup installs the pinned package locally.
npx is an alias of package; absolute uses this checkout. Hooks run Node through the shim.
`);
}

export function printConfigHelp(): void {
  console.log(`agent-presence config

Usage:
  agent-presence config show
  agent-presence config provider feishu-signature --base-url <url> --preview-base-url <url> --image-key <key> --target-url <url>
  agent-presence config provider feishu-signature --reset
  agent-presence config render --zero <template> --one <template> --many <template>
  agent-presence config render --reset

Template variables:
  {total}     active agent count
  {details}   grouped source counts, for example: codex 1 · claude 1
  {usage}     token usage badge for the default window (usage.signatureWindowDays)
  {usage_1d}  today's usage badge (since local midnight), for example: 2.1M · $4.50
  {usage_7d}  last-7-calendar-days usage badge; any {usage_Nd} works
              (referencing a usage token enables scanning; compose your own label)
`);
}
