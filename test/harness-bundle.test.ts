import { planInstall } from '@rivus/agent-kit/harness';
import { builtinHookDialects } from '@rivus/agent-kit/harness/events';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createPresenceBundle, PRESENCE_AGENTS } from '../src/harness/bundle.js';
import { createHarnessFixture, renderedRegistrations, type HarnessFixture } from './harness-support.js';

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop'
];
const EXPECTED_EVENTS = {
  'claude-code': CLAUDE_EVENTS,
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'],
  'gemini-cli': ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd'],
  grok: CLAUDE_EVENTS,
  opencode: [
    'command.executed',
    'file.edited',
    'message.part.updated',
    'message.updated',
    'permission.asked',
    'permission.replied',
    'permission.updated',
    'question.asked',
    'question.rejected',
    'question.replied',
    'session.compacted',
    'session.created',
    'session.deleted',
    'session.diff',
    'session.error',
    'session.idle',
    'session.status',
    'session.updated',
    'todo.updated',
    'tool.execute.after',
    'tool.execute.before'
  ],
  pi: [
    'agent_end',
    'agent_settled',
    'agent_start',
    'before_agent_start',
    'session_compact',
    'session_shutdown',
    'session_start',
    'tool_call',
    'tool_execution_end',
    'tool_execution_start',
    'turn_end',
    'turn_start',
    'ui_prompt_end',
    'ui_prompt_start'
  ]
};

let fixture: HarnessFixture | undefined;
afterEach(async () => fixture?.dispose());

describe('presence harness bundle', () => {
  it('renders the complete native events, per-agent timeout units and one expanded command through the public kit plan', async () => {
    fixture = await createHarnessFixture();
    const bundle = createPresenceBundle(fixture.presenceHome);
    const plan = await fixture.run(planInstall(bundle, { agents: PRESENCE_AGENTS }));
    const hook = bundle.artifacts.find((artifact) => artifact.type === 'hooks');
    if (hook === undefined) {
      throw new Error('The presence bundle needs a hook spec');
    }
    expect([...PRESENCE_AGENTS].sort()).toEqual(Object.keys(EXPECTED_EVENTS).sort());
    for (const agent of PRESENCE_AGENTS) {
      const registrations = renderedRegistrations(plan, agent);
      expect(registrations.map(({ event }) => event).sort()).toEqual([...EXPECTED_EVENTS[agent]].sort());
      expect([...new Set(registrations.map(({ command }) => command))]).toEqual([
        `${fixture.presenceHome}/bin/agent-presence hook --agent ${agent} 2>/dev/null || echo '{}'`
      ]);
      const timeout = agent === 'gemini-cli' ? 5_000 : agent === 'opencode' || agent === 'pi' ? undefined : 5;
      expect([...new Set(registrations.map((registration) => registration.timeout))]).toEqual([timeout]);
      const dialect = builtinHookDialects[agent];
      const acceptedNames = Object.entries(dialect.events).flatMap(([event, spec]) => [event, ...(spec.aliases ?? [])]);
      expect(registrations.every(({ event }) => acceptedNames.includes(event))).toBe(true);
      expect(hook.events[agent]?.every((event) => Object.hasOwn(dialect.events, event))).toBe(true);
    }
    expect(fixture.availableCalls).toContain('codex');
    expect(fixture.cliCalls).toEqual([]);
    expect(fixture.processCalls).toEqual([]);
  });
});
