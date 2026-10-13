import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = resolve(repoRoot, 'src/cli.ts');
const hookCommandEntry = resolve(repoRoot, 'src/cli/commands/hook.ts');

// The hook path's static graph loads only repository modules, Node built-ins,
// and the npm entries in hookGraphPackages (docs/architecture.md, "CLI"). Any
// other bare specifier is an npm package loaded on every hook run, so the walk
// fails on it; this keeps `effect`, `zod`, and `@clack/prompts` out. The
// forbidden modules are the setup/installer cluster, the Clack wrapper, the
// helpers only setup, uninstall, and login use, and the modules that hold
// schemas or scan transcripts: the state store, the queue's schemas and
// reader, the usage events log, the billable source table, and every usage
// scanner. The bin entry and the dispatcher are walked as well as the hook
// command, because a static setup import in `src/cli/app.ts` pulls the whole
// graph into every hook run just as one in the hook command does.
const usageDir = resolve(repoRoot, 'src/usage');
const usageScanners = readdirSync(usageDir)
  .filter((name) => name.startsWith('scan-') && name.endsWith('.ts'))
  .map((name) => resolve(usageDir, name));
const forbiddenHookGraphModules = [
  'src/setup.ts',
  'src/installers.ts',
  'src/plugin-install.ts',
  'src/migration.ts',
  'src/power-watcher.ts',
  'src/magic-token.ts',
  'src/cli/credential.ts',
  'src/cli/magic-builder-setup.ts',
  'src/cli/ui.ts',
  'src/cli/commands/setup.ts',
  'src/cli/commands/uninstall.ts',
  'src/cli/commands/login.ts',
  'src/state-store.ts',
  'src/queue/schema.ts',
  'src/queue/reader.ts',
  'src/usage-events-log.ts',
  'src/usage/billable-sources.ts'
]
  .map((relative) => resolve(repoRoot, relative))
  .concat(usageScanners);
const scriptsDir = resolve(repoRoot, 'scripts');
// Every npm entry the hook path loads statically, by exact specifier. A batch
// that brings a package into the hook path adds it here; `effect` and `zod`
// never go on this list (docs/architecture.md, "CLI"). The kit's process lock
// and Node platform are here because the log lock reaches them through
// `src/sources.ts`, `src/cli/hook-output.ts`, and `src/cli/io.ts`.
const hookGraphPackages = [
  '@rivus/agent-kit-collab/process-lock',
  '@rivus/agent-kit/harness/events',
  '@rivus/agent-kit/node'
];
// Imported by the hook command (through `src/sources.ts`), not by the
// dispatcher, so its presence in the graph shows the walk followed the hook
// command's imports.
const deepHookModule = resolve(repoRoot, 'src/cli/hook-context.ts');

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
  packageSpecifiers: string[];
}

// A resolved file that cannot be read throws: a renamed or moved module must
// fail the walk, not silently shrink the graph.
function walkStaticGraph(entries: string[]): StaticGraph {
  const files = new Set<string>();
  const packageSpecifiers = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) {
      continue;
    }
    files.add(file);
    for (const specifier of staticImportSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveRelativeImport(file, specifier);
      if (target !== undefined) {
        queue.push(target);
      } else if (!specifier.startsWith('node:')) {
        packageSpecifiers.add(specifier);
      }
    }
  }
  return { files: [...files].sort(), packageSpecifiers: [...packageSpecifiers].sort() };
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
  it('loads only Node built-ins and the allowed npm entries and never reaches setup, installer, prompt, schema, or scanner modules', () => {
    // The scanner list comes from a directory listing; an empty one would forbid nothing.
    expect(usageScanners).toContain(resolve(usageDir, 'scan-dsh.ts'));
    const graph = walkStaticGraph([cliEntry, hookCommandEntry]);

    expect(graph.files).toEqual(expect.arrayContaining([cliEntry, hookCommandEntry, deepHookModule]));
    const reachedForbidden = graph.files.filter(
      (file) => forbiddenHookGraphModules.includes(file) || file.startsWith(`${scriptsDir}/`)
    );
    expect(reachedForbidden).toEqual([]);
    expect(graph.packageSpecifiers).toEqual(hookGraphPackages);
  });
});
