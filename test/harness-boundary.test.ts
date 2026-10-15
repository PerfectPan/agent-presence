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

const astNode = z.looseObject({ type: z.string() });
const astChildren = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);
const stringLiteral = z.object({ type: z.literal('Literal'), value: z.string() });
const identifier = z.object({ type: z.literal('Identifier'), name: z.string() });
type AstNode = z.infer<typeof astNode>;
type Origin = 'package' | 'Effect' | 'Runtime' | 'ManagedRuntime' | `run${string}`;
interface Bindings {
  parent?: Bindings;
  names: Map<string, Origin | undefined>;
}

function node(value: unknown): AstNode | undefined {
  const parsed = z.safeParse(astNode, value);
  return parsed.success ? parsed.data : undefined;
}

function name(value: unknown): string | undefined {
  const id = z.safeParse(identifier, value);
  const literal = z.safeParse(stringLiteral, value);
  return id.success ? id.data.name : literal.success ? literal.data.value : undefined;
}

function moduleName(value: unknown): string | undefined {
  const literal = z.safeParse(stringLiteral, value);
  if (literal.success) {
    return literal.data.value;
  }
  const template = z.safeParse(
    z.object({
      type: z.literal('TemplateLiteral'),
      expressions: z.tuple([]),
      quasis: z.tuple([z.object({ value: z.object({ cooked: z.string() }) })])
    }),
    value
  );
  return template.success ? template.data.quasis[0].value.cooked : undefined;
}

function moduleOrigin(specifier: string | undefined): Origin | undefined {
  if (specifier === 'effect') {
    return 'package';
  }
  return specifier === 'effect/Effect'
    ? 'Effect'
    : specifier === 'effect/Runtime'
      ? 'Runtime'
      : specifier === 'effect/ManagedRuntime'
        ? 'ManagedRuntime'
        : undefined;
}

function memberOrigin(origin: Origin | undefined, member: string | undefined): Origin | undefined {
  if (origin === 'package' && (member === 'Effect' || member === 'Runtime' || member === 'ManagedRuntime')) {
    return member;
  }
  return (origin === 'package' || origin === 'Effect') && member?.startsWith('run')
    ? (member as `run${string}`)
    : undefined;
}

function effectRunners(source: string, jsx = false): string[] {
  const nodes: { entry: AstNode; scope: Bindings }[] = [];
  function visit(value: unknown, parent: Bindings): void {
    const parsed = node(value);
    const scope =
      parsed &&
      [
        'BlockStatement',
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
        'CatchClause'
      ].includes(parsed.type)
        ? { parent, names: new Map<string, Origin | undefined>() }
        : parent;
    const children = z.safeParse(astChildren, value);
    if (children.success) {
      Object.values(children.data).forEach((child) => visit(child, scope));
    }
    // Initializers and assignment values read the binding before it changes.
    if (parsed) {
      nodes.push({ entry: parsed, scope });
    }
  }
  visit(parseAst(source, { lang: jsx ? 'tsx' : 'ts' }), { names: new Map() });
  const runners: string[] = [];
  const report = (origin: Origin | undefined) => {
    if (origin === 'Runtime' || origin === 'ManagedRuntime' || origin?.startsWith('run')) {
      runners.push(origin);
    }
  };
  function expressionOrigin(value: unknown, scope: Bindings): Origin | undefined {
    const expression = node(value);
    if (!expression) {
      return undefined;
    }
    switch (expression.type) {
      case 'Identifier':
        for (let current: Bindings | undefined = scope; current; current = current.parent) {
          const key = z.parse(z.string(), expression.name);
          if (current.names.has(key)) {
            return current.names.get(key);
          }
        }
        return undefined;
      case 'AwaitExpression':
        return expressionOrigin(expression.argument, scope);
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
        return expressionOrigin(expression.expression, scope);
      case 'ImportExpression':
        return moduleOrigin(moduleName(expression.source));
      case 'CallExpression':
        return name(expression.callee) === 'require'
          ? moduleOrigin(moduleName(z.parse(z.array(z.unknown()), expression.arguments)[0]))
          : undefined;
      case 'MemberExpression':
        return memberOrigin(expressionOrigin(expression.object, scope), name(expression.property));
      default:
        return undefined;
    }
  }
  function bind(pattern: unknown, origin: Origin | undefined, scope: Bindings, imported = false): void {
    const target = node(pattern);
    if (!target) {
      return;
    }
    if (target.type === 'Identifier') {
      scope.names.set(z.parse(z.string(), target.name), origin);
      if (imported) {
        report(origin);
      }
    } else if (target.type === 'ObjectPattern') {
      for (const property of z.parse(z.array(astNode), target.properties)) {
        const member = memberOrigin(origin, name(property.key));
        report(member);
        bind(property.value, member, scope);
      }
    } else if (target.type === 'AssignmentPattern') {
      bind(target.left, origin, scope);
    }
  }
  for (const { entry, scope } of nodes) {
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(entry.type)) {
      for (const parameter of z.parse(z.array(z.unknown()), entry.params)) {
        bind(parameter, undefined, scope);
      }
    } else if (entry.type === 'CatchClause') {
      bind(entry.param, undefined, scope);
    }
    if (entry.type === 'ImportDeclaration') {
      const origin = moduleOrigin(moduleName(entry.source));
      report(origin);
      for (const specifier of z.parse(z.array(astNode), entry.specifiers)) {
        bind(
          specifier.local,
          specifier.type === 'ImportSpecifier' ? memberOrigin(origin, name(specifier.imported)) : origin,
          scope,
          true
        );
      }
    } else if (entry.type === 'TSImportEqualsDeclaration') {
      bind(entry.id, moduleOrigin(moduleName(node(entry.moduleReference)?.expression)), scope, true);
    }
  }
  for (const { entry, scope } of nodes) {
    if (entry.type === 'VariableDeclarator') {
      bind(entry.id, expressionOrigin(entry.init, scope), scope);
    } else if (entry.type === 'AssignmentExpression' && entry.operator === '=') {
      bind(entry.left, expressionOrigin(entry.right, scope), scope);
    }
    if (entry.type === 'MemberExpression') {
      report(expressionOrigin(entry, scope));
    } else if (entry.type === 'ImportExpression' || entry.type === 'TSImportType') {
      const origin = moduleOrigin(moduleName(entry.source));
      report(origin);
      if (entry.type === 'TSImportType') {
        report(memberOrigin(origin, name(entry.qualifier)));
      }
    } else if (entry.type === 'CallExpression' && name(entry.callee) === 'require') {
      report(expressionOrigin(entry, scope));
    } else if (entry.type === 'ExportNamedDeclaration') {
      const origin = moduleOrigin(moduleName(entry.source));
      for (const specifier of z.parse(z.array(astNode), entry.specifiers)) {
        report(memberOrigin(origin, name(specifier.local)));
      }
    } else if (entry.type === 'ExportAllDeclaration' && moduleOrigin(moduleName(entry.source))) {
      runners.push('export all runners');
    }
  }
  return runners;
}

describe('harness runtime boundary', () => {
  it('allows Effect programs but keeps all runners at the lazy CLI harness root', () => {
    expect(
      effectRunners(`
      import { Effect as E, type Exit } from 'effect';
      import * as Effects from 'effect/Effect';
      import * as Kit from 'effect';
      const Alias = Kit.Effect;
      const program: E.Effect<number> = E.gen(function* () { return yield* Effects.promise(async () => 1); });
      const another = Alias.succeed(1);
      const unrelated = { runPromise() {} }; unrelated.runPromise();
      let reassigned = E; reassigned = unrelated; reassigned.runPromise();
      function build() { const local = E; return local.succeed(1); }
      function other() { const local = unrelated; return local.runPromise(); }
      function shadow(E: typeof unrelated) { return E.runPromise(); }
      const example = "Effect.runPromise(program)";
      // Effect.runSync(program);
    `)
    ).toEqual([]);
    const forbidden = [
      `import {Effect as E} from 'effect'; E.runPromise(program);`,
      `import {Effect} from 'effect'; let E = Effect; E.runPromise(program); E = unrelated;`,
      `import {Effect} from 'effect'; function run() { const E = Effect; E.runPromise(program); } function other() { const E = unrelated; }`,
      `import * as E from 'effect/Effect'; const Alias = E; Alias.runSync(program);`,
      `import {Effect} from 'effect'; let E; E = Effect; E.runPromise(program);`,
      `import {Effect} from 'effect'; const {runPromise: execute} = Effect; execute(program);`,
      `import {runPromise as execute} from 'effect/Effect'; execute(program);`,
      `import {Runtime as R} from 'effect'; R.runPromise(program);`,
      `import type {ManagedRuntime} from 'effect/ManagedRuntime';`,
      `import * as Kit from 'effect'; Kit.ManagedRuntime.make(layer);`,
      `async function run() { const {Effect: E} = await import('effect'); E.runPromise(program); }`,
      `async function run() { const {runPromise: execute} = await import(\`effect/Effect\`); execute(program); }`,
      `import E = require('effect/Effect'); E.runPromise(program);`,
      `const {Effect: E} = require('effect'); const execute = E.runPromise;`,
      `export {runPromise} from 'effect/Effect';`,
      `export * from 'effect/Runtime';`
    ];
    for (const source of forbidden) {
      expect(effectRunners(source).length).toBeGreaterThan(0);
    }
    const runners = sourceFiles(join(repoRoot, 'src')).flatMap((file) =>
      effectRunners(readFileSync(file, 'utf8'), file.endsWith('x')).map((operation) => ({
        file: relative(repoRoot, file),
        operation
      }))
    );
    expect(runners).toEqual([{ file: 'src/cli/harness.ts', operation: 'runPromiseExit' }]);
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
