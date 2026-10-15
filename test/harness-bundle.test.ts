import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { planInstall } from '@rivus/agent-kit/harness';
import { builtinHookDialects } from '@rivus/agent-kit/harness/events';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import * as z from 'zod/mini';
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
  it('identifies its package version and hashes artifacts canonically with a stable shell-quoted command', () => {
    const home = "/work/presence's home";
    const bundle = createPresenceBundle(home);
    const hook = bundle.artifacts.find((artifact) => artifact.type === 'hooks');
    expect(hook).toBeDefined();
    if (hook === undefined) {
      throw new Error('The presence bundle needs a hook spec');
    }
    expect(bundle.owner).toBe('agent-presence');
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.legacyMarkers).toBeUndefined();
    const pkg = z.parse(
      z.object({ version: z.string() }),
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    );
    expect(bundle.version).toBe(pkg.version);
    expect(hook.command).toBe(
      "'/work/presence'\\''s home/bin/agent-presence' hook --agent {agent} 2>/dev/null || echo '{}'"
    );
    expect(hook.timeoutSeconds).toBe(5);
    expect(Object.keys(hook.events).sort()).toEqual([...PRESENCE_AGENTS].sort());

    const keys = ['command', 'events', 'timeoutSeconds', 'type', ...PRESENCE_AGENTS].sort();
    const reordered = [
      {
        events: Object.fromEntries(Object.entries(hook.events).reverse()),
        timeoutSeconds: 5,
        command: hook.command,
        type: 'hooks'
      }
    ];
    const canonical = JSON.stringify(reordered, keys);
    expect(JSON.stringify(bundle.artifacts, keys)).toBe(canonical);
    expect(bundle.digest).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(createPresenceBundle(home)).toEqual(bundle);
    expect(createPresenceBundle('/work/another-home').digest).not.toBe(bundle.digest);
  });

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
