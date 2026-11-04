import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import * as z from 'zod/mini';
import { createPresenceBundle, PRESENCE_AGENTS } from './bundle.js';

describe('presence harness bundle', () => {
  it('identifies its package version and hashes artifacts canonically with a stable shell-quoted command', () => {
    const home = "/work/presence's home";
    const bundle = createPresenceBundle(home);
    const hook = bundle.artifacts.find((artifact) => artifact.type === 'hooks');
    expect(hook).toBeDefined();
    if (hook === undefined) {
      throw new Error('The presence bundle needs a hook spec');
    }
    expect(bundle.owner).toBe('agent-presence');
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.legacyMarkers).toBeUndefined();
    const pkg = z.parse(
      z.object({ version: z.string() }),
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    );
    expect(bundle.version).toBe(pkg.version);
    expect(hook.command).toBe(
      "'/work/presence'\\''s home/bin/agent-presence' hook --agent {agent} 2>/dev/null || echo '{}'"
    );
    expect(hook.timeoutSeconds).toBe(5);
    expect(Object.keys(hook.events).sort()).toEqual([...PRESENCE_AGENTS].sort());

    const keys = ['command', 'events', 'timeoutSeconds', 'type', ...PRESENCE_AGENTS].sort();
    const reordered = [
      {
        events: Object.fromEntries(Object.entries(hook.events).reverse()),
        timeoutSeconds: 5,
        command: hook.command,
        type: 'hooks'
      }
    ];
    const canonical = JSON.stringify(reordered, keys);
    expect(JSON.stringify(bundle.artifacts, keys)).toBe(canonical);
    expect(bundle.digest).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(createPresenceBundle(home)).toEqual(bundle);
    expect(createPresenceBundle('/work/another-home').digest).not.toBe(bundle.digest);
  });
});
