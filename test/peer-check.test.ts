import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import * as z from 'zod/mini';

const { packageManager } = z
  .object({ packageManager: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
const pnpm = process.env.npm_execpath ?? 'pnpm';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(effectVersion: string) {
  const directory = mkdtempSync(join(tmpdir(), 'kit-peer-check-'));
  directories.push(directory);
  const dependencies: Record<string, string> = {};
  for (const manifest of [
    {
      name: '@rivus/agent-kit',
      version: '1.0.0',
      peerDependencies: { effect: '1.0.0' },
      peerDependenciesMeta: { effect: { optional: true } }
    },
    { name: 'effect', version: effectVersion }
  ]) {
    const archiveName = `${manifest.name.replaceAll('/', '-').replaceAll('@', '')}.tgz`;
    const sourceDirectory = join(directory, archiveName.slice(0, -4));
    mkdirSync(join(sourceDirectory, 'package'), { recursive: true });
    writeFileSync(join(sourceDirectory, 'package', 'package.json'), JSON.stringify(manifest));
    execFileSync('tar', ['-czf', join(directory, archiveName), '-C', sourceDirectory, 'package']);
    dependencies[manifest.name] = `file:${archiveName}`;
  }
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'kit-peer-fixture', private: true, dependencies })
  );
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  return directory;
}

function runPnpm(directory: string, args: string[]) {
  return spawnSync(pnpm, [...args, '--store-dir', join(directory, 'store')], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, COREPACK_ENABLE_NETWORK: '0' },
    timeout: 30_000
  });
}

function generateLockfile(directory: string) {
  // Use the repository's running pnpm without asking an isolated HOME to download a package manager.
  expect(runPnpm(directory, ['--version']).stdout.trim()).toBe(packageManager.split('@').at(-1));
  // Allow an incompatible graph to be written, as an updater with relaxed peer checks might do.
  const result = runPnpm(directory, ['install', '--offline', '--ignore-scripts', '--no-strict-peer-dependencies']);
  expect(result.status, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
}

it('accepts a compatible exact optional Effect peer in the lockfile', () => {
  const directory = createFixture('1.0.0');
  generateLockfile(directory);

  const result = runPnpm(directory, ['peers', 'check', '--lockfile-only', '--json']);

  expect(result.status, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ '.': { bad: {} } });
}, 60_000);

it('rejects an incompatible installed optional Effect peer in the lockfile', () => {
  const directory = createFixture('2.0.0');
  generateLockfile(directory);

  const result = runPnpm(directory, ['peers', 'check', '--lockfile-only', '--json']);

  expect(result.status, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    '.': {
      bad: {
        effect: [
          {
            optional: true,
            wantedRange: '1.0.0',
            foundVersion: '2.0.0',
            parents: [{ name: '@rivus/agent-kit', version: '1.0.0' }]
          }
        ]
      }
    }
  });
}, 60_000);
