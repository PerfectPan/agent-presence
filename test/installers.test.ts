import { describe, expect, it } from 'vitest';
import {
  PI_EXTENSION_FILE_NAME,
  PI_EXTENSION_MARKER,
  buildOpenCodePluginSource,
  buildPiExtensionSource,
  buildPowerEventWatcherSwift,
  buildShutdownWatcherPlist,
  buildShutdownWatcherScript,
  isAgentSignatureCommand,
  withClaudeAgentSignatureHooks,
  withOpenCodeAgentSignaturePluginConfig,
  withPiAgentPresenceExtension,
  withoutOpenCodeAgentSignaturePluginConfig,
  withoutPiAgentPresenceExtension
} from '../src/installers.js';
import type { HookSettings, PiSettings } from '../src/installers.js';

function withAbsoluteCliPath<T>(fn: () => T): T {
  const previousMode = process.env.AGENT_PRESENCE_HOOK_COMMAND;
  const previousCliPath = process.env.AGENT_PRESENCE_CLI_PATH;
  process.env.AGENT_PRESENCE_HOOK_COMMAND = 'absolute';
  process.env.AGENT_PRESENCE_CLI_PATH = '/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js';
  try {
    return fn();
  } finally {
    if (previousMode === undefined) {
      delete process.env.AGENT_PRESENCE_HOOK_COMMAND;
    } else {
      process.env.AGENT_PRESENCE_HOOK_COMMAND = previousMode;
    }
    if (previousCliPath === undefined) {
      delete process.env.AGENT_PRESENCE_CLI_PATH;
    } else {
      process.env.AGENT_PRESENCE_CLI_PATH = previousCliPath;
    }
  }
}

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
    expect(
      isAgentSignatureCommand(
        'npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@0.1.2 hook --source codex --event Stop'
      )
    ).toBe(true);
    expect(isAgentSignatureCommand('agent-signature hook --source codex --event Stop')).toBe(true);
    expect(isAgentSignatureCommand('agent-signature.mjs hook --source codex --event Stop')).toBe(true);
  });

  it('recognizes absolute-mode hook commands', () => {
    expect(
      isAgentSignatureCommand(
        '/Users/example/.nvm/versions/node/v24.8.0/bin/node /Users/example/agent-presence/dist/src/cli.js hook --source codex --event Stop'
      )
    ).toBe(true);
    expect(
      isAgentSignatureCommand(
        '/usr/local/bin/node /usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js hook --source claude --event PreToolUse'
      )
    ).toBe(true);
  });

  it('generates absolute hook commands when AGENT_PRESENCE_HOOK_COMMAND=absolute', () => {
    withAbsoluteCliPath(() => {
      const settings: Partial<HookSettings> = { hooks: {} };
      const next = withClaudeAgentSignatureHooks(settings);

      const command = next.hooks.SessionStart[0]?.hooks?.[0]?.command ?? '';
      expect(command).toContain(`hook --source claude --event SessionStart --silent`);
      expect(command).not.toContain('npx');
      expect(command).toContain('/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js');
    });
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

  it('generates watcher scripts with absolute CLI path when AGENT_PRESENCE_HOOK_COMMAND=absolute', () => {
    withAbsoluteCliPath(() => {
      const script = buildShutdownWatcherScript({
        pathEntries: ['/Users/example/.nvm/versions/node/v24.8.0/bin'],
        powerEventWatcherPath: '/Users/example/.agent-presence/power-watch.swift'
      });
      const swift = buildPowerEventWatcherSwift();

      expect(script).not.toContain('npx');
      expect(script).toContain('/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js');
      expect(swift).not.toContain('npx');
      expect(swift).toContain('/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js');
    });
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
    expect(source).toContain('props.info?.id');
    expect(source).toContain('value.event ? pickSessionId(value.event) : undefined');
    expect(source).toContain('spawnSync(CLI_COMMAND[0], args');
    expect(source).toContain('export default AgentSignaturePlugin');
  });

  it('generates an opencode plugin with absolute CLI command', () => {
    const source = buildOpenCodePluginSource(['/usr/local/bin/node', '/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js']);

    expect(source).toContain('const CLI_COMMAND = ["/usr/local/bin/node","/usr/local/lib/node_modules/@rivus/agent-presence/dist/src/cli.js"]');
    expect(source).toContain('--source');
    expect(source).toContain('opencode');
    expect(source).toContain('session.created');
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

describe('pi extension installer helpers', () => {
  it('targets the canonical pi extension file name', () => {
    expect(PI_EXTENSION_FILE_NAME).toBe('agent-presence.ts');
  });

  it('generates a TypeScript extension that bridges Pi lifecycle events into the presence CLI', () => {
    const source = buildPiExtensionSource();

    expect(source).toContain(PI_EXTENSION_MARKER);
    expect(source).toContain('import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"');
    expect(source).toContain('const CLI_COMMAND = ["npx","--yes","--registry=https://registry.npmjs.org","@rivus/agent-presence@');
    expect(source).toContain('--source');
    expect(source).toContain('"pi"');
    // We must NOT subscribe to session_start as a SessionStart trigger; opening pi
    // without a task should never count as active.
    expect(source).not.toContain('emit("SessionStart", false, ctx)\n  })\n\n  pi.on("session_start"');
    expect(source).toContain('pi.on("before_agent_start"');
    expect(source).toContain('pi.on("turn_start"');
    expect(source).toContain('pi.on("tool_execution_start"');
    expect(source).toContain('pi.on("tool_execution_end"');
    expect(source).toContain('pi.on("agent_end"');
    expect(source).toContain('pi.on("session_shutdown"');
    expect(source).toContain('emit("SessionStart"');
    expect(source).toContain('emit("Heartbeat"');
    expect(source).toContain('emit("Stop", true, ctx)');
    expect(source).toContain('spawnSync(CLI_COMMAND[0]');
    // Hook errors must never crash Pi.
    expect(source).toContain('// Never let presence telemetry break Pi.');
  });

  it('generates an extension that uses an absolute CLI command when requested', () => {
    const source = buildPiExtensionSource(['/usr/local/bin/node', '/opt/agent-presence/dist/src/cli.js']);

    expect(source).toContain('const CLI_COMMAND = ["/usr/local/bin/node","/opt/agent-presence/dist/src/cli.js"]');
    expect(source).not.toContain('npx');
  });

  it('keeps unrelated pi extension entries intact and never duplicates the managed entry', () => {
    const settings: PiSettings = { extensions: ['/Users/example/.pi/agent/extensions/user-extension.ts'] };
    const managedPath = '/Users/example/.pi/agent/extensions/agent-presence.ts';

    const next = withPiAgentPresenceExtension(settings, managedPath);
    expect(next.extensions).toEqual(['/Users/example/.pi/agent/extensions/user-extension.ts']);

    const settingsWithDup: PiSettings = {
      extensions: [
        '/Users/example/.pi/agent/extensions/user-extension.ts',
        '/Users/example/.pi/agent/extensions/agent-presence.ts'
      ]
    };
    const cleaned = withPiAgentPresenceExtension(settingsWithDup, managedPath);
    expect(cleaned.extensions).toEqual(['/Users/example/.pi/agent/extensions/user-extension.ts']);
  });

  it('uninstall strips the managed entry without touching user extensions', () => {
    const settings: PiSettings = {
      extensions: [
        '/Users/example/.pi/agent/extensions/user-extension.ts',
        '/Users/example/.pi/agent/extensions/agent-presence.ts'
      ]
    };
    const managedPath = '/Users/example/.pi/agent/extensions/agent-presence.ts';

    expect(withoutPiAgentPresenceExtension(settings, managedPath)).toEqual({
      extensions: ['/Users/example/.pi/agent/extensions/user-extension.ts']
    });
  });

  it('drops the extensions key when removing the only managed entry', () => {
    const settings: PiSettings = {
      extensions: ['/Users/example/.pi/agent/extensions/agent-presence.ts']
    };

    expect(withoutPiAgentPresenceExtension(settings, settings.extensions![0])).toEqual({});
  });
});
