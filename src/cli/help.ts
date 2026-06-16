export function printHelp(): void {
  console.log(`agent-presence

Usage:
  agent-presence login [--provider feishu-signature]
  agent-presence setup [--provider feishu-signature] [--login] [--skip-login] [--no-hooks] [--hook-command <npx|absolute>]
  agent-presence uninstall [--credentials] [--all]
  agent-presence url [--provider feishu-signature]
  agent-presence config show
  agent-presence config provider feishu-signature [--base-url <url>] [--preview-base-url <url>] [--image-key <key>] [--target-url <url>] [--reset]
  agent-presence config render [--zero <template>] [--one <template>] [--many <template>] [--reset]
  agent-presence status [--provider feishu-signature] [--remote]
  agent-presence usage [--days <n>] [--json]
  agent-presence update [--provider feishu-signature] [--force] [--value <text>] [--silent]
  agent-presence reset [--provider feishu-signature] [--force] [--silent]
  agent-presence hook --source codex --event <SessionStart|Heartbeat|UserPromptSubmit|PreToolUse|Stop>
  agent-presence hook --source claude --event <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd|SubagentStart|SubagentStop> --silent
  agent-presence hook --source gemini --event <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd> --silent
  agent-presence hook --source opencode --event <SessionStart|Heartbeat|Stop> --silent
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
