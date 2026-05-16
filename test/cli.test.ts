import { describe, expect, it } from 'vitest';
import { hasAnyOption, hasFlag, optionValue, parseArgs } from '../src/cli/args.js';
import { resolveHookContext } from '../src/cli/hook-context.js';
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

describe('cli hook context', () => {
  it('keeps hook context resolution outside the interactive cli layer', () => {
    const previousThreadId = process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_THREAD_ID;

    try {
      expect(
        resolveHookContext('codex', {
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
