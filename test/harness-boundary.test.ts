import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';
import * as z from 'zod/mini';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

const stringLiteral = z.object({ type: z.literal('Literal'), value: z.string() });
const templateLiteral = z.object({
  type: z.literal('TemplateLiteral'),
  expressions: z.tuple([]),
  quasis: z.tuple([z.object({ value: z.object({ cooked: z.string() }) })])
});
const moduleReference = z.union([
  z.object({
    type: z.enum([
      'ImportDeclaration',
      'ExportAllDeclaration',
      'ExportNamedDeclaration',
      'ImportExpression',
      'TSImportType'
    ]),
    source: z.union([stringLiteral, templateLiteral])
  }),
  z.object({
    type: z.literal('TSImportEqualsDeclaration'),
    moduleReference: z.object({ type: z.literal('TSExternalModuleReference'), expression: stringLiteral })
  }),
  z.object({
    type: z.literal('CallExpression'),
    callee: z.object({ type: z.literal('Identifier'), name: z.literal('require') }),
    arguments: z.tuple([stringLiteral])
  })
]);
const astChildren = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);

function effectModuleSpecifiers(source: string, jsx = false): string[] {
  const specifiers: string[] = [];
  function visit(value: unknown): void {
    const reference = z.safeParse(moduleReference, value);
    if (reference.success) {
      const node = reference.data;
      const specifier =
        node.type === 'TSImportEqualsDeclaration'
          ? node.moduleReference.expression.value
          : node.type === 'CallExpression'
            ? node.arguments[0].value
            : node.source.type === 'Literal'
              ? node.source.value
              : node.source.quasis[0].value.cooked;
      if (specifier === 'effect' || specifier.startsWith('effect/')) {
        specifiers.push(specifier);
      }
    }
    const children = z.safeParse(astChildren, value);
    if (children.success) {
      Object.values(children.data).forEach(visit);
    }
  }
  visit(parseAst(source, { lang: jsx ? 'tsx' : 'ts' }));
  return specifiers;
}

describe('harness runtime boundary', () => {
  it('keeps every Effect import and its one runner at the lazy CLI harness root', () => {
    expect(
      effectModuleSpecifiers(`
      // import { Runtime } from 'effect';
      const example = "import('effect')";
      import { Runtime as R } from 'effect';
      import type { ManagedRuntime } from 'effect/ManagedRuntime';
      export { runPromise } from 'effect/Effect';
      export * from 'effect/Runtime';
      import E = require('effect/Effect');
      async function lazy() { const { runPromise } = await import('effect/Effect'); }
      const runtime = () => import(\`effect/ManagedRuntime\`);
      const required = require('effect');
      type RuntimeType = import('effect/Runtime').Runtime<never>;
    `)
    ).toEqual([
      'effect',
      'effect/ManagedRuntime',
      'effect/Effect',
      'effect/Runtime',
      'effect/Effect',
      'effect/Effect',
      'effect/ManagedRuntime',
      'effect',
      'effect/Runtime'
    ]);
    const files = sourceFiles(join(repoRoot, 'src'));
    const imports = files.flatMap((file) =>
      effectModuleSpecifiers(readFileSync(file, 'utf8'), file.endsWith('x')).map((specifier) => ({
        file: relative(repoRoot, file),
        specifier
      }))
    );
    expect(imports).toEqual([{ file: 'src/cli/harness.ts', specifier: 'effect' }]);
    const runners = files.flatMap((file) =>
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
