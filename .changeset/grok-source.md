---
'@rivus/agent-presence': minor
---

Add Grok as a built-in source. It appears in `agent-presence source list`, and `agent-presence hook --agent grok` reads a Grok hook payload as Grok sends it: Grok's snake_case event names (`session_start`, `user_prompt_submit`, `stop`, and so on) and their PascalCase spellings map to presence's lifecycle events, and subagent start and stop track their own session, `<sessionId>:subagent:<subagentId or subagentType>`. When Grok runs Claude Code's hooks, `hook --agent claude-code` counts the event for Grok. `hook --source grok` also works: it takes the event from `--event` when given, and otherwise maps the payload's event name the same way. `setup` installs Grok hooks at `~/.grok/hooks/agent-presence.json`.
