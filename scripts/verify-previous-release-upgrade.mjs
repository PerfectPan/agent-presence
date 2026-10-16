#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Network acceptance is explicit and stays outside the offline test suite.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const scratch = await mkdtemp(join(tmpdir(), 'presence-release-upgrade-'));
try {
  const archive = join(scratch, 'release.tgz');
  execFileSync(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--proto',
      '=https',
      '--connect-timeout',
      '10',
      '--max-time',
      '30',
      '--retry',
      '1',
      '--retry-max-time',
      '45',
      '--output',
      archive,
      'https://registry.npmjs.org/@rivus/agent-presence/-/agent-presence-0.9.0.tgz'
    ],
    { timeout: 60_000 }
  );
  const tarball = await readFile(archive);
  const digest = createHash('sha256').update(tarball).digest('hex');
  if (digest !== '9a8767a720e0fec494d2549ccc910fea10c576411368ab31e903ee567d3661b1') {
    throw new Error(`Unexpected 0.9.0 tarball SHA-256: ${digest}`);
  }
  console.log(`registry.npmjs.org @rivus/agent-presence@0.9.0 SHA-256 ${digest}`);
  execFileSync('tar', ['-xzf', archive, '-C', scratch], { timeout: 10_000 });
  const home = join(scratch, 'runner-home');
  await mkdir(home);
  const env = { ...process.env, HOME: home, PRESENCE_UPGRADE_PACKAGE: join(scratch, 'package') };
  for (const key of Object.keys(env)) {
    if (/^(AGENT_PRESENCE_|AGENT_SIGNATURE_|CLAUDE_|CODEX_|GEMINI_|GROK_|PI_|OPENCODE_|XDG_|DSH_|FEISHU_)/.test(key)) {
      delete env[key];
    }
  }
  delete env.PRESENCE_SECRET_INTEGRATION;
  const vitest = join(
    dirname(require.resolve('vitest/package.json', { paths: [require.resolve('vite-plus/package.json')] })),
    'vitest.mjs'
  );
  execFileSync(process.execPath, [vitest, 'run', '--config', 'test/manual/upgrade.config.ts'], {
    cwd: root,
    env,
    stdio: 'inherit',
    timeout: 180_000
  });
} finally {
  await rm(scratch, { recursive: true, force: true });
}
