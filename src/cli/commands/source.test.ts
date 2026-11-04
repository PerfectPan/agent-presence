import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { source } from './source.js';

let previousExitCode: number | undefined;

beforeEach(() => {
  previousExitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
});

describe('source add', () => {
  it('errors when no package spec is given', async () => {
    await source(['add', '--yes']);
    expect(process.exitCode).toBe(1);
  });
});
