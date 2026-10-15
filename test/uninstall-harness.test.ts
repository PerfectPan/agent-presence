import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ExternalOwner, applyInstall, doctor, planInstall, verify, type Bundle } from '@rivus/agent-kit/harness';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as z from 'zod/mini';
import { uninstall } from '../src/cli/commands/uninstall.js';
import { createPresenceBundle, PRESENCE_AGENTS } from '../src/harness/bundle.js';
import { queuePaths } from '../src/queue/files.js';
import { AGENT_HOME_VARIABLES, createHarnessFixture, type HarnessFixture } from './harness-support.js';

const removals = vi.hoisted(() => ({
  scripts: vi.fn<typeof import('../src/setup.js').runUninstallScripts>(),
  credentials: vi.fn<typeof import('../src/secret.js').deleteCredential>(),
  plugins: vi.fn<typeof import('../src/plugin-install.js').removePluginsDir>()
}));
vi.mock('../src/setup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/setup.js')>()),
  runUninstallScripts: removals.scripts
}));
vi.mock('../src/secret.js', () => ({ deleteCredential: removals.credentials }));
vi.mock('../src/plugin-install.js', () => ({ removePluginsDir: removals.plugins }));

let fixture: HarnessFixture;
let lines: string[];
let errors: string[];
let savedExitCode: typeof process.exitCode;
const installedHooksSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(
      z.object({
        hooks: z.array(z.object({ command: z.string(), timeout: z.number() }))
      })
    )
  )
});

beforeEach(async () => {
  fixture = await createHarnessFixture();
  for (const name of AGENT_HOME_VARIABLES) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('AGENT_PRESENCE_HOME', fixture.presenceHome);
  vi.stubEnv('AGENT_PRESENCE_CONFIG_FILE', join(fixture.presenceHome, 'config.json'));
  vi.stubEnv('AGENT_PRESENCE_NO_PROMPTS', '1');
  await mkdir(fixture.presenceHome, { recursive: true });
  await writeFile(join(fixture.presenceHome, 'config.json'), '{"provider":"feishu-signature","slot_id":"saved-slot"}');
  lines = [];
  errors = [];
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => lines.push(parts.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => errors.push(parts.join(' ')));
  removals.credentials.mockReset().mockResolvedValue(undefined);
  removals.plugins.mockReset().mockResolvedValue(undefined);
  removals.scripts.mockReset().mockImplementation(async ({ scriptNames = [] } = {}) => {
    if (existsSync(join(fixture.presenceHome, 'bin/agent-presence'))) {
      throw new Error('The shim must be removed before own scripts run');
    }
    return scriptNames.map((scriptName) => ({ scriptName, scriptPath: `/dist/scripts/${scriptName}` }));
  });
});

afterEach(async () => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.dispose();
});

async function install(agents: readonly (typeof PRESENCE_AGENTS)[number][] = PRESENCE_AGENTS) {
  await fixture.writeShim();
  const bundle = createPresenceBundle(fixture.presenceHome);
  const plan = await fixture.run(planInstall(bundle, { agents }));
  await fixture.run(applyInstall(plan));
  return { bundle, plan };
}

describe('ledger-backed uninstall', () => {
  it.each(PRESENCE_AGENTS)(
    '%s installs, verifies, repeats unchanged, and restores unrelated settings and comments',
    async (agent) => {
      const baseline = new Map([
        [join(fixture.home, '.claude/settings.json'), '{\n  // keep claude comment\n  "theme": "light"\n}\n'],
        [
          join(fixture.home, '.codex/config.toml'),
          '# keep codex comment\nmodel = "other"\n\n[marketplaces]\nother = true\n\n[plugins]\n"other@other" = true\n'
        ],
        [join(fixture.home, '.gemini/settings.json'), '{\n  // keep gemini comment\n  "theme": "light"\n}\n'],
        [
          join(fixture.home, '.config/opencode/opencode.json'),
          '{\n  // keep opencode comment\n  "theme": "light"\n}\n'
        ],
        [join(fixture.home, '.pi/agent/settings.json'), '{\n  "theme": "light"\n}\n']
      ]);
      for (const [path, text] of baseline) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
      }
      const { bundle, plan } = await install([agent]);
      expect(
        (await fixture.run(verify('agent-presence', { bundle, agents: [agent] }))).artifacts.every(
          ({ status }) => status === 'in-sync'
        )
      ).toBe(true);
      expect(
        (await fixture.run(doctor({ owner: 'agent-presence', agents: [agent] }))).every(({ status }) => status === 'ok')
      ).toBe(true);
      const snapshots = await Promise.all(
        plan.steps
          .filter(({ locator }) => locator.kind !== 'cli-registration')
          .map(async ({ locator }) => {
            const path =
              locator.kind === 'dir'
                ? join(locator.path, agent === 'codex' ? 'plugins/agent-presence/hooks/hooks.json' : 'hooks/hooks.json')
                : locator.path;
            return { path, text: await readFile(path, 'utf8') };
          })
      );
      for (const { text } of snapshots) {
        if (agent === 'opencode' || agent === 'pi') {
          expect(text).toContain(
            `Generated for agent-presence by @rivus/agent-kit: forwards ${agent === 'pi' ? 'Pi' : agent} events`
          );
          expect(text).toContain('spawnSync');
          expect(text).toContain('timeout: 5000');
          expect(text).toContain(agent === 'opencode' ? 'session.idle' : 'session_shutdown');
        } else {
          const hooks = installedHooksSchema.parse(JSON.parse(text)).hooks;
          expect(
            Object.values(hooks)
              .flatMap((groups) => groups.flatMap((group) => group.hooks))
              .every(({ timeout }) => timeout === (agent === 'gemini-cli' ? 5_000 : 5))
          ).toBe(true);
          if (agent === 'gemini-cli') {
            expect(Object.keys(hooks)).toEqual([
              'SessionStart',
              'BeforeAgent',
              'BeforeTool',
              'AfterTool',
              'AfterAgent',
              'SessionEnd'
            ]);
          }
        }
      }
      if (agent === 'claude-code') {
        expect(plan.steps.some(({ locator }) => locator.path.endsWith('.claude/skills/agent-presence'))).toBe(true);
        expect(await readFile(join(fixture.home, '.claude/settings.json'), 'utf8')).toBe(
          baseline.get(join(fixture.home, '.claude/settings.json'))
        );
      }
      const repeated = await fixture.run(planInstall(bundle, { agents: [agent] }));
      expect(repeated.steps.every(({ action }) => action === 'noop')).toBe(true);
      await fixture.run(applyInstall(repeated));
      for (const { path, text } of snapshots) {
        expect(await readFile(path, 'utf8')).toBe(text);
      }

      await uninstall([], {}, fixture.layer);

      for (const [path, text] of baseline) {
        expect(await readFile(path, 'utf8')).toBe(text);
      }
      for (const { locator } of plan.steps) {
        if (locator.kind !== 'cli-registration') {
          await expect(stat(locator.path)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(lines.some((line) => line.includes(`remove (delete): ${locator.path}`))).toBe(true);
        }
      }
      await expect(stat(join(fixture.presenceHome, 'bin/agent-presence'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(removals.credentials).not.toHaveBeenCalled();
      expect(removals.plugins).not.toHaveBeenCalled();
      expect(fixture.processCalls).toEqual([]);
      expect(errors).toEqual([]);
      expect(lines).toContain('uninstall: ok');
      expect(process.exitCode).toBeUndefined();
    }
  );

  it('verify with the bundle reports desired artifacts missing from both disk and ledger', async () => {
    const bundle = createPresenceBundle(fixture.presenceHome);
    const report = await fixture.run(verify('agent-presence', { bundle, agents: PRESENCE_AGENTS }));
    expect(report.artifacts.length).toBeGreaterThanOrEqual(PRESENCE_AGENTS.length);
    expect(report.artifacts.every(({ status }) => status === 'missing')).toBe(true);
  });

  it('leaves an old-format presence entry planted after setup byte-identical', async () => {
    await install();
    const path = join(fixture.home, '.claude/settings.json');
    const text =
      '{\n  // old format stays\n  "hooks": {"SessionStart":[{"hooks":[{"type":"command","command":"npx @rivus/agent-presence@0.8.0 hook --agent claude-code"}]}]}\n}\n';
    await writeFile(path, text);

    await uninstall([], {}, fixture.layer);

    expect(await readFile(path, 'utf8')).toBe(text);
    expect(lines).toContain('uninstall: ok');
  });

  it('reports why an artifact released to another owner stays on disk', async () => {
    const bundle: Bundle = {
      owner: 'agent-presence',
      version: '1.0.0',
      digest: 'shared-skill',
      artifacts: [{ type: 'skill', name: 'shared-skill', files: { 'SKILL.md': '# Shared skill\n' } }]
    };
    const first = await fixture.run(planInstall(bundle, { agents: ['codex'] }));
    await fixture.run(applyInstall(first));
    const second = await fixture.run(planInstall({ ...bundle, owner: 'another-owner' }, { agents: ['codex'] }));
    await fixture.run(applyInstall(second));
    const target = first.steps[0]?.locator.path;
    if (target === undefined) {
      throw new Error('The shared skill must have a target');
    }

    await uninstall([], {}, fixture.layer);

    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('# Shared skill\n');
    expect(lines).toContain(`uninstall kept: ${target} (still used by other owners or agents)`);
  });

  it.each(['user-modified', 'dotfiles-managed', 'symlinked-target'] as const)(
    'reports the path and %s reason for kept artifacts',
    async (reason) => {
      const { plan } = await install(['pi']);
      const target = plan.steps[0]?.locator.path;
      expect(target).toBeDefined();
      if (target === undefined) {
        throw new Error('Pi must have an artifact');
      }
      const original = await readFile(target, 'utf8');
      const text = `${original}\n// user change\n`;
      if (reason === 'symlinked-target') {
        const external = join(fixture.home, 'external.ts');
        await writeFile(external, original);
        await rm(target);
        await symlink(external, target);
      } else if (reason === 'dotfiles-managed') {
        fixture.managedPaths.set(await realpath(target), 'dotfiles');
      } else {
        await writeFile(target, text);
      }

      await uninstall([], {}, fixture.layer);

      expect(lines).toContain(`uninstall kept: ${target} (${reason})`);
      expect(await readFile(target, 'utf8')).toContain(reason === 'user-modified' ? '// user change' : 'COMMAND');
      expect(lines).toContain('uninstall: ok');
    }
  );

  it('continues shim, own scripts, credentials and queue removal after a kit failure without claiming success', async () => {
    await fixture.writeShim();
    const statePath = join(fixture.presenceHome, 'state.json');
    await writeFile(statePath, '{"sessions":{}}');
    const failureLayer = Layer.merge(
      fixture.layer,
      Layer.succeed(ExternalOwner, {
        managedPaths: () => Effect.die(new Error('simulated kit failure'))
      })
    );

    await uninstall(['--all'], { startWorker: () => undefined }, failureLayer);

    expect(errors.join('\n')).toContain('simulated kit failure');
    expect(removals.scripts.mock.calls.flatMap(([options]) => options?.scriptNames ?? [])).toContain(
      'uninstall-dsh-plugin.js'
    );
    expect(removals.credentials).toHaveBeenCalledOnce();
    expect(removals.plugins).toHaveBeenCalledOnce();
    await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(queuePaths(statePath).disabled, 'utf8')).toBeDefined();
    expect(JSON.parse(await readFile(join(fixture.presenceHome, 'config.json'), 'utf8'))).not.toHaveProperty('slot_id');
    expect(lines).toContain('uninstall: incomplete');
    expect(lines).not.toContain('uninstall: ok');
    expect(process.exitCode).toBe(1);
  });

  it('continues the remaining independent removals when an own script fails', async () => {
    await fixture.writeShim();
    removals.scripts.mockRejectedValueOnce(new Error('simulated script failure'));

    await uninstall(['--credentials'], {}, fixture.layer);

    expect(removals.scripts).toHaveBeenCalledTimes(process.platform === 'darwin' ? 2 : 1);
    expect(removals.credentials).toHaveBeenCalledOnce();
    expect(errors.join('\n')).toContain('simulated script failure');
    expect(lines).toContain('uninstall: incomplete');
    expect(process.exitCode).toBe(1);
  });
});
