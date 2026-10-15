import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import * as z from 'zod/mini';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('harness runtime boundary', () => {
  it('has one Effect runner at the lazy CLI harness root', () => {
    const runners = sourceFiles(join(repoRoot, 'src')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bEffect\.(run\w+)\s*\(/g)].map((match) => ({
        file: relative(repoRoot, file),
        method: match[1]
      }))
    );
    expect(runners).toEqual([{ file: 'src/cli/harness.ts', method: 'runPromiseExit' }]);
  });

  it('resolves one exact Effect version shared by the kit peer and both kit packages', () => {
    const kit = z.parse(
      z.object({ version: z.string(), peerDependencies: z.object({ effect: z.string() }) }),
      JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@rivus/agent-kit/package.json')), 'utf8'))
    );
    const pkg = z.parse(
      z.object({ dependencies: z.record(z.string(), z.string()) }),
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    );
    expect(kit.version).toBe('0.17.0');
    expect(kit.peerDependencies.effect).toBe('4.0.3');
    expect(pkg.dependencies['@rivus/agent-kit']).toBe(kit.version);
    expect(pkg.dependencies['@rivus/agent-kit-collab']).toBe(kit.version);
    expect(pkg.dependencies.effect).toBe(kit.peerDependencies.effect);

    const lockfile = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    const dependencyLockfile = lockfile.split('\n---\n').at(-1) ?? '';
    const packages = dependencyLockfile.split('\nsnapshots:')[0] ?? '';
    expect([...packages.matchAll(/^  effect@([^:]+):$/gm)].map((match) => match[1])).toEqual([
      kit.peerDependencies.effect
    ]);
    expect([...new Set([...lockfile.matchAll(/^  effect@([^:]+):/gm)].map((match) => match[1]))]).toEqual([
      kit.peerDependencies.effect
    ]);
    expect(lockfile).toContain(`'@rivus/agent-kit@${kit.version}(effect@${kit.peerDependencies.effect})'`);
    expect(lockfile).toContain(
      `'@rivus/agent-kit-collab@${kit.version}(@rivus/agent-kit@${kit.version}(effect@${kit.peerDependencies.effect}))(effect@${kit.peerDependencies.effect})'`
    );
  });
});
