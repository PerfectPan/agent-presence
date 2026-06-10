import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMagicToken } from '../src/magic-token.js';

describe('readMagicToken', () => {
  let originalEnv: string | undefined;
  let workDir: string;

  beforeEach(async () => {
    originalEnv = process.env.MAGIC_TOKEN;
    delete process.env.MAGIC_TOKEN;
    workDir = await mkdtemp(join(tmpdir(), 'agent-presence-magic-token-'));
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.MAGIC_TOKEN;
    } else {
      process.env.MAGIC_TOKEN = originalEnv;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns undefined when no source is available', async () => {
    const result = await readMagicToken(workDir);
    expect(result.token).toBeUndefined();
    expect(result.source).toBeUndefined();
  });

  it('reads from the MAGIC_TOKEN env var first', async () => {
    process.env.MAGIC_TOKEN = 'env-token-value';
    const result = await readMagicToken(workDir);
    expect(result).toEqual({ token: 'env-token-value', source: 'env' });
  });

  it('reads project-local .magic-token when env is unset and trims whitespace', async () => {
    await writeFile(join(workDir, '.magic-token'), '  project-token  \n');
    const result = await readMagicToken(workDir);
    expect(result.token).toBe('project-token');
    expect(result.source).toBe('file');
    expect(result.path).toBe(join(workDir, '.magic-token'));
  });
});
