import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeNpmRunner } from '../src/harness/runtime.js';

export const installFixtureRuntime: RuntimeNpmRunner = async (_command, args) => {
  const prefix = args[args.indexOf('--prefix') + 1];
  const version = args.at(-1)?.split('@').at(-1);
  if (!prefix || !version) {
    throw new Error('Missing fixture runtime prefix or version');
  }
  const root = join(prefix, 'node_modules/@rivus/agent-presence');
  await mkdir(join(root, 'dist/src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@rivus/agent-presence', version }));
  await writeFile(join(root, 'dist/src/cli.js'), 'console.log("fixture runtime");\n');
};
