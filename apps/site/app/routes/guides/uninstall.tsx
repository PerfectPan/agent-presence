import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "Uninstall — Agent Presence" }];
}

export default function Uninstall() {
  return (
    <Doc
      locale="en"
      title="Uninstall"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>
        </>
      }
    >
      <p>
        <code>agent-presence setup</code> installs hooks for Codex, Claude Code,
        Gemini CLI, opencode, the Pi extension, and the macOS power watcher.
        Uninstall is <strong>idempotent</strong> — it succeeds cleanly even on a
        machine with no installed hooks.
      </p>

      <h2>Default uninstall (keeps credentials)</h2>
      <pre><code>{`agent-presence uninstall`}</code></pre>
      <p>
        The default uninstall intentionally <strong>keeps credentials, local
        state, and provider config</strong> so a later{" "}
        <code>agent-presence setup --skip-login</code> can reinstall hooks without
        another QR scan.
      </p>
      <p>It removes:</p>
      <ul>
        <li>managed Codex hooks (<code>~/.codex/hooks.json</code>)</li>
        <li>managed Claude Code hooks (<code>~/.claude/settings.json</code>)</li>
        <li>managed Gemini CLI hooks (<code>~/.gemini/settings.json</code>)</li>
        <li>managed opencode plugin (<code>~/.config/opencode/plugins/agent-presence.js</code>)</li>
        <li>managed Pi Coding Agent extension (<code>~/.pi/agent/extensions/agent-presence.ts</code>)</li>
        <li>the macOS power watcher (Linux skips this)</li>
      </ul>

      <h2>Clear login credentials and slot config</h2>
      <pre><code>{`agent-presence uninstall --credentials`}</code></pre>

      <h2>Clear everything</h2>
      <pre><code>{`agent-presence uninstall --all`}</code></pre>
      <p>
        Removes hooks, credentials, slot config, local state, and the managed
        runtime.
      </p>

      <h2>Manual macOS cleanup (equivalent)</h2>
      <pre><code>{`security delete-generic-password -s 'agent-signature:l-garyyang' -a token 2>/dev/null || true
security delete-generic-password -s 'agent-signature:l-garyyang' -a slotId 2>/dev/null || true
security delete-generic-password -s 'agent-signature-slot-credential' -a "\${USER:-agent-presence}" 2>/dev/null || true
printf '{}\\n' > ~/.agent-presence/config.json
# Legacy config path, used by older installs:
printf '{}\\n' > ~/.codex/agent-signature/config.json`}</code></pre>

      <h2>Manual package scripts</h2>
      <p>These remain available from a local checkout:</p>
      <pre><code>{`pnpm run install:all-hooks
pnpm run uninstall:all-hooks
pnpm run install:shutdown-watcher
pnpm run uninstall:shutdown-watcher`}</code></pre>
    </Doc>
  );
}
