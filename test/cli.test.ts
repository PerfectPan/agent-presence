import { describe, expect, it, vi } from 'vite-plus/test';
import { hasAnyOption, hasFlag, optionValue, parseArgs } from '../src/cli/args.js';
import { printHelp } from '../src/cli/help.js';
import { resolveBuiltinHookContext } from '../src/cli/hook-context.js';
import { assertMacOS, assertSupportedPlatform, isMacOS, isSupportedPlatform } from '../src/platform.js';

describe('cli args', () => {
  it('splits the command from command arguments', () => {
    expect(parseArgs(['status', '--remote'])).toEqual({
      command: 'status',
      args: ['--remote']
    });
  });

  it('reads flags and option values', () => {
    const args = ['--provider', 'feishu-signature', '--force'];

    expect(optionValue(args, '--provider')).toBe('feishu-signature');
    expect(hasFlag(args, '--force')).toBe(true);
    expect(hasAnyOption(args, ['--value', '--force'])).toBe(true);
  });
});

describe('cli help', () => {
  it('shows the installed agent form and direct source form without legacy per-source event lists', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printHelp();
      const help = log.mock.calls.flat().join('\n');
      expect(help.split('\n').filter((line) => line.includes('agent-presence hook'))).toEqual([
        '  agent-presence hook --agent <claude-code|codex|gemini-cli|grok|opencode|pi>',
        '  agent-presence hook --source <id> --event <name> [--silent]'
      ]);
      expect(help).toContain(
        'Direct hook calls use --source with claude, codex,\ngemini, grok, dsh, or a configured source'
      );
      expect(help).toContain('an internal event name');
    } finally {
      log.mockRestore();
    }
  });
});

describe('cli hook context', () => {
  it('keeps hook context resolution outside the interactive cli layer', () => {
    const previousThreadId = process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_THREAD_ID;

    try {
      expect(
        resolveBuiltinHookContext('codex', {
          thread_id: 'thread-1',
          cwd: '/repo'
        })
      ).toEqual({
        sessionId: 'thread-1',
        project: '/repo'
      });
    } finally {
      process.env.CODEX_THREAD_ID = previousThreadId;
    }
  });
});

describe('platform support', () => {
  it('supports macOS and Linux, rejects Windows', () => {
    expect(isSupportedPlatform('darwin')).toBe(true);
    expect(isSupportedPlatform('linux')).toBe(true);
    expect(isSupportedPlatform('win32')).toBe(false);
    expect(() => assertSupportedPlatform('win32')).toThrow('macOS and Linux');
  });

  it('assertMacOS rejects non-macOS platforms', () => {
    expect(isMacOS('darwin')).toBe(true);
    expect(isMacOS('linux')).toBe(false);
    expect(isMacOS('win32')).toBe(false);
    expect(() => assertMacOS('linux')).toThrow('power watcher requires macOS');
    expect(() => assertMacOS('win32')).toThrow('power watcher requires macOS');
  });
});
