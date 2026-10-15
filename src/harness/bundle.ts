import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle, HookSpec, JsonValue } from '@rivus/agent-kit/harness';
import { builtinHookDialects } from '@rivus/agent-kit/harness/events';
import * as z from 'zod/mini';
import { getHomeDir } from '../config.js';

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

const PRESENCE_EVENTS = {
  'claude-code': CLAUDE_EVENTS,
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'],
  'gemini-cli': ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd'],
  grok: CLAUDE_EVENTS,
  opencode: Object.keys(builtinHookDialects.opencode.events),
  pi: Object.keys(builtinHookDialects.pi.events)
} satisfies HookSpec['events'];

export const PRESENCE_AGENTS: readonly (keyof typeof PRESENCE_EVENTS)[] = Object.keys(
  PRESENCE_EVENTS
) as (keyof typeof PRESENCE_EVENTS)[];

const packageSchema = z.object({
  name: z.literal('@rivus/agent-presence'),
  version: z.string().check(z.minLength(1))
});

function packageVersion(): string {
  for (const url of [
    new URL('../../package.json', import.meta.url),
    new URL('../../../package.json', import.meta.url)
  ]) {
    try {
      return packageSchema.parse(JSON.parse(readFileSync(url, 'utf8'))).version;
    } catch {
      // Source and dist builds resolve package.json from different depths.
    }
  }
  throw new Error('unable to resolve @rivus/agent-presence package version');
}

function shellQuote(value: string): string {
  // Match the installer quoting rule without loading its agent-config writers.
  if (/^[A-Za-z0-9_/:=@.-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function canonicalJson(value: JsonValue): string {
  // This narrows the known JSON union, not an unvalidated object.
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: JsonValue) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function createPresenceBundle(home = getHomeDir()): Bundle {
  const hook: HookSpec = {
    type: 'hooks',
    command: `${shellQuote(join(home, 'bin', 'agent-presence'))} hook --agent {agent} 2>/dev/null || echo '{}'`,
    events: PRESENCE_EVENTS,
    timeoutSeconds: 5
  };
  const artifacts = [hook];
  const digest = createHash('sha256')
    .update(canonicalJson(z.json().parse(artifacts)))
    .digest('hex');
  return { owner: 'agent-presence', version: packageVersion(), digest, artifacts };
}
