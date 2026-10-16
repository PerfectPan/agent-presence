import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import * as z from 'zod/mini';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const rootFile = 'src/cli/harness.ts';
const forbidden =
  /\b(?:runPromise|runPromiseExit|runSync|runSyncExit|runFork|runCallback|ManagedRuntime)\b|\bRuntime\s*\./;

describe('harness runtime boundary', () => {
  it('keeps runner names at the CLI harness root', () => {
    // This check is lexical; comments and strings count, and aliases are out of scope.
    for (const file of globSync('src/**/*.ts', { cwd: repoRoot }).filter((file) => file !== rootFile)) {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      expect({ file, match: source.match(forbidden)?.[0] }).toEqual({ file, match: undefined });
    }
    expect([...readFileSync(join(repoRoot, rootFile), 'utf8').matchAll(/\brunPromiseExit\b/g)]).toHaveLength(1);
  });

  it('resolves one exact Effect version shared by the kit peer and both kit packages', () => {
    const kitUrl = new URL(import.meta.resolve('@rivus/agent-kit/package.json'));
    const kit = z
      .object({ version: z.string(), peerDependencies: z.object({ effect: z.string() }) })
      .parse(JSON.parse(readFileSync(kitUrl, 'utf8')));
    const pkg = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')));
    const version = kit.version;
    const peer = kit.peerDependencies.effect;
    expect(version).toBe('0.18.0');
    expect(peer).toBe('4.0.3');
    expect(pkg.dependencies['@rivus/agent-kit']).toBe(version);
    expect(pkg.dependencies['@rivus/agent-kit-collab']).toBe(version);
    expect(pkg.dependencies.effect).toBe(peer);
    const lockfile = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    const packages = (lockfile.split('\n---\n').at(-1) ?? '').split('\nsnapshots:')[0] ?? '';
    expect([...packages.matchAll(/^  effect@([^:]+):$/gm)].map((match) => match[1])).toEqual([peer]);
    expect([...new Set([...lockfile.matchAll(/^  effect@([^:]+):/gm)].map((match) => match[1]))]).toEqual([peer]);
    expect(lockfile).toContain(`'@rivus/agent-kit@${version}(effect@${peer})'`);
    expect(lockfile).toContain(
      `'@rivus/agent-kit-collab@${version}(@rivus/agent-kit@${version}(effect@${peer}))(effect@${peer})'`
    );
  });
});
