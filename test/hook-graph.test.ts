import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = resolve(repoRoot, 'src/cli.ts');
const hookCommandEntry = resolve(repoRoot, 'src/cli/commands/hook.ts');

// Modules the hook path must never load statically: the setup/installer cluster
// and the helpers only setup, uninstall, and login use. The bin entry and the
// dispatcher are walked as well as the hook command, because a static setup
// import in `src/cli/app.ts` pulls the whole graph into every hook run just as
// one in the hook command does. The graph must also stay free of `effect`;
// later batches must not be able to reach it from the hook path
// (docs/architecture.md, "Hook Setup Split").
const forbiddenHookGraphModules = [
  'src/setup.ts',
  'src/installers.ts',
  'src/plugin-install.ts',
  'src/migration.ts',
  'src/power-watcher.ts',
  'src/magic-token.ts',
  'src/cli/credential.ts',
  'src/cli/magic-builder-setup.ts',
  'src/cli/commands/setup.ts',
  'src/cli/commands/uninstall.ts',
  'src/cli/commands/login.ts'
].map((relative) => resolve(repoRoot, relative));
const scriptsDir = resolve(repoRoot, 'scripts');

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const node of parseAst(source, { lang: 'ts' }).body) {
    // Import declarations whose specifiers are all inline `type` are erased,
    // but the module still loads under verbatimModuleSyntax, so any
    // non-`type` declaration is a static edge. `import x = require('...')`
    // with a module reference is the same kind of edge unless it is
    // `import type`. ImportExpression is dynamic import(): a lazy edge, not
    // part of the static graph.
    if (node.type === 'ImportDeclaration') {
      if (node.importKind !== 'type') {
        specifiers.push(node.source.value);
      }
    } else if (node.type === 'TSImportEqualsDeclaration') {
      if (node.importKind !== 'type' && node.moduleReference.type === 'TSExternalModuleReference') {
        specifiers.push(node.moduleReference.expression.value);
      }
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exportKind !== 'type') {
        specifiers.push(node.source.value);
      }
    } else if (node.type === 'ExportNamedDeclaration' && node.source !== null) {
      // A re-export whose specifiers are all inline `type` emits no runtime
      // import and is skipped. An empty re-export (`export {} from`) and any
      // re-export with a value specifier keep their runtime edge.
      const typeOnlySpecifiers =
        node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.exportKind === 'type');
      if (node.exportKind !== 'type' && !typeOnlySpecifiers) {
        specifiers.push(node.source.value);
      }
    }
  }
  return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const base = resolve(dirname(fromFile), specifier);
  if (base.endsWith('.js')) {
    return `${base.slice(0, -3)}.ts`;
  }
  if (base.endsWith('.ts') || base.endsWith('.json')) {
    return base;
  }
  return `${base}.ts`;
}

interface StaticGraph {
  files: string[];
  effectSpecifiers: string[];
}

function walkStaticGraph(entries: string[]): StaticGraph {
  const files = new Set<string>();
  const effectSpecifiers = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) {
      continue;
    }
    files.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of staticImportSpecifiers(source)) {
      if (specifier === 'effect' || specifier.startsWith('effect/')) {
        effectSpecifiers.add(specifier);
        continue;
      }
      const target = resolveRelativeImport(file, specifier);
      if (target !== undefined) {
        queue.push(target);
      }
    }
  }
  return { files: [...files].sort(), effectSpecifiers: [...effectSpecifiers] };
}

describe('static import scanning', () => {
  it('keeps the runtime edge of an import whose specifiers are all inline type', () => {
    expect(staticImportSpecifiers(`import { type SetupScriptResult } from './setup.js';\n`)).toEqual(['./setup.js']);
  });

  it('skips a re-export whose specifiers are all inline type but keeps value and empty re-exports', () => {
    expect(staticImportSpecifiers(`export { type SetupScriptResult } from './setup.js';\n`)).toEqual([]);
    expect(staticImportSpecifiers(`export { type SetupScriptResult, runSetupScripts } from './setup.js';\n`)).toEqual([
      './setup.js'
    ]);
    expect(staticImportSpecifiers(`export {} from './setup.js';\n`)).toEqual(['./setup.js']);
    expect(staticImportSpecifiers(`export type { SetupScriptResult } from './setup.js';\n`)).toEqual([]);
  });

  it('counts an import equals with a relative module reference as a static edge unless it is a type import', () => {
    expect(staticImportSpecifiers(`import setupApi = require('./setup.js');\n`)).toEqual(['./setup.js']);
    expect(staticImportSpecifiers(`import type setupApi = require('./setup.js');\n`)).toEqual([]);
  });
});

describe('hook static import graph', () => {
  it('never reaches setup, installer, or effect modules from the bin entry or the hook command', () => {
    const graph = walkStaticGraph([cliEntry, hookCommandEntry]);

    const reachedForbidden = graph.files.filter(
      (file) => forbiddenHookGraphModules.includes(file) || (file.startsWith(`${scriptsDir}/`) && file !== scriptsDir)
    );
    expect(reachedForbidden).toEqual([]);
    expect(graph.effectSpecifiers).toEqual([]);
  });
});
