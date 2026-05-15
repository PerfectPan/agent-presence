import { describe, expect, it } from 'vitest';
import {
  buildOpenCodePluginSource,
  buildPowerEventWatcherSwift,
  buildShutdownWatcherPlist,
  buildShutdownWatcherScript,
  isAgentSignatureCommand,
  withClaudeAgentSignatureHooks,
  withOpenCodeAgentSignaturePluginConfig,
  withTrustedCodexHookHashes,
  withoutOpenCodeAgentSignaturePluginConfig
} from '../src/installers.js';
import type { HookSettings } from '../src/installers.js';

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

describe('Codex hook trust helpers', () => {
  it('updates existing trusted hashes and appends missing hook state entries', () => {
    const next = withTrustedCodexHookHashes(
      `[features]
hooks = true

[hooks.state."/Users/example/.codex/hooks.json:pre_tool_use:1:0"]
trusted_hash = "sha256:old"
`,
      [
        {
          key: '/Users/example/.codex/hooks.json:pre_tool_use:1:0',
          trustedHash: 'sha256:new-pre'
        },
        {
          key: '/Users/example/.codex/hooks.json:session_start:2:0',
          trustedHash: 'sha256:new-start'
        }
      ]
    );

    expect(next).toContain('trusted_hash = "sha256:new-pre"');
    expect(next).not.toContain('trusted_hash = "sha256:old"');
    expect(next).toContain('[hooks.state."/Users/example/.codex/hooks.json:session_start:2:0"]');
    expect(next).toContain('trusted_hash = "sha256:new-start"');
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
