import { describe, expect, it } from 'vitest';
import {
  buildOpenCodePluginSource,
  buildPowerEventWatcherSwift,
  buildShutdownWatcherPlist,
  buildShutdownWatcherScript,
  isAgentSignatureCommand,
  withClaudeAgentSignatureHooks,
  withOpenCodeAgentSignaturePluginConfig,
  withoutOpenCodeAgentSignaturePluginConfig
} from '../src/installers.js';
import type { HookSettings } from '../src/installers.js';

describe('Claude hook installer helpers', () => {
  it('preserves existing hooks and installs silent agent-presence commands once', () => {
    const settings: Partial<HookSettings> = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo existing'
              },
              {
                type: 'command',
                command: 'agent-signature hook --source claude --event Stop --silent >/dev/null 2>/dev/null || true'
              }
            ]
          }
        ]
      }
    };

    const next = withClaudeAgentSignatureHooks(settings);

    expect(next.hooks.Stop).toHaveLength(2);
    expect(next.hooks.Stop[0]?.hooks?.[0]?.command).toBe('echo existing');
    expect(next.hooks.Stop[1]?.hooks?.[0]?.command).toContain('npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@');
    expect(next.hooks.Stop[1]?.hooks?.[0]?.command).toContain('hook --source claude --event Stop --silent');
    expect(next.hooks.SessionStart.at(-1)?.hooks?.[0]?.command).toContain('hook --source claude --event SessionStart --silent');
  });

  it('recognizes current and legacy managed hook commands', () => {
    expect(isAgentSignatureCommand('agent-presence hook --source codex --event Stop')).toBe(true);
    expect(isAgentSignatureCommand('agent-signature hook --source codex --event Stop')).toBe(true);
    expect(isAgentSignatureCommand('agent-signature.mjs hook --source codex --event Stop')).toBe(true);
  });
});

describe('shutdown watcher installer helpers', () => {
  it('generates a launch agent plist and a watcher script that reset presence on termination and sleep events', () => {
    const plist = buildShutdownWatcherPlist({
      label: 'work.rivus.agent-presence.power-watch',
      scriptPath: '/Users/example/.agent-presence/power-watch.sh'
    });
    const script = buildShutdownWatcherScript({
      pathEntries: ['/Users/example/.nvm/versions/node/v24.8.0/bin'],
      powerEventWatcherPath: '/Users/example/.agent-presence/power-watch.swift'
    });
    const swift = buildPowerEventWatcherSwift();

    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('work.rivus.agent-presence.power-watch');
    expect(plist).toContain('/Users/example/.agent-presence/power-watch.sh');
    expect(script).toContain('trap cleanup TERM HUP INT EXIT');
    expect(script).toContain('export PATH="/Users/example/.nvm/versions/node/v24.8.0/bin:$PATH"');
    expect(script).toContain('/usr/bin/swift "/Users/example/.agent-presence/power-watch.swift"');
    expect(script).toContain('npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@');
    expect(swift).toContain('NSWorkspace.willSleepNotification');
    expect(swift).toContain('NSWorkspace.screensDidSleepNotification');
    expect(swift).toContain('NSWorkspace.didWakeNotification');
    expect(swift).toContain('npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@');
  });
});

describe('opencode plugin installer helpers', () => {
  it('generates an opencode plugin that feeds lifecycle events into the CLI silently', () => {
    const source = buildOpenCodePluginSource();

    expect(source).toContain('const CLI_COMMAND = ["npx","--yes","--registry=https://registry.npmjs.org","@rivus/agent-presence@');
    expect(source).toContain('--source');
    expect(source).toContain('opencode');
    expect(source).toContain('session.created');
    expect(source).toContain('session.idle');
    expect(source).toContain('--silent');
  });

  it('adds and removes the plugin from opencode config without losing existing plugins', () => {
    const config = { plugin: ['./plugins/cmux-session.js', './plugins/agent-signature.js'] };

    expect(withOpenCodeAgentSignaturePluginConfig(config)).toEqual({
      plugin: ['./plugins/cmux-session.js', './plugins/agent-presence.js']
    });
    expect(withoutOpenCodeAgentSignaturePluginConfig(config)).toEqual({
      plugin: ['./plugins/cmux-session.js']
    });
  });
});
