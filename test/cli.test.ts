import { describe, expect, it } from 'vitest';
import { hasAnyOption, hasFlag, optionValue, parseArgs } from '../src/cli/args.js';
import { resolveHookContext } from '../src/cli/hook-context.js';

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
