import { Link } from "react-router";
import { Doc, Note, Caution } from "~/components/Doc";

export function meta() {
  return [{ title: "Installation — Agent Presence" }];
}

export default function InstallGuide() {
  return (
    <Doc
      locale="en"
      title="Installation"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>
        </>
      }
    >
      <p>
        <code>@rivus/agent-presence</code> runs on <strong>macOS and Linux</strong>.
        The CLI and installer scripts detect unsupported platforms and exit with a
        clear error. <strong>Windows is not supported yet.</strong>
      </p>
      <table>
        <thead>
          <tr>
            <th>Platform</th>
            <th>Credentials</th>
            <th>Power watcher</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>macOS</td>
            <td>Keychain</td>
            <td>Installs a LaunchAgent power watcher</td>
          </tr>
          <tr>
            <td>Linux</td>
            <td>secret-tool / libsecret</td>
            <td><strong>Skipped</strong> — TTL pruning clears expired sessions</td>
          </tr>
        </tbody>
      </table>

      <h2>Prerequisites</h2>
      <ul>
        <li><strong>Node</strong> {">=20"} (the CLI engine)</li>
        <li><strong>pnpm</strong> {">=11.1.1"} (pinned via <code>packageManager: pnpm@11.1.1</code>)</li>
      </ul>

      <h2>Install from the registry</h2>
      <pre><code>{`pnpm add -g @rivus/agent-presence
agent-presence setup`}</code></pre>
      <p>
        The default provider is <code>magic-builder</code>, so bare commands target
        it. The first <code>setup</code> runs the l.garyyang QR login (which stores
        the slot credential) and then prompts for a Magic-Builder token used to
        publish the preview FaaS.
      </p>
      <Note>
        To use the direct <code>l.garyyang.work</code> preview instead — which
        needs <strong>no</strong> Magic-Builder token — pass{" "}
        <code>--provider feishu-signature</code>.
      </Note>

      <h2>Without a global install</h2>
      <pre><code>{`npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup`}</code></pre>
      <p>
        When run via <code>npx</code>, installed hooks use the package's{" "}
        <strong>fixed published version</strong> instead of a floating{" "}
        <code>latest</code> or a global <code>agent-presence</code> binary.
      </p>

      <h2>Restricted PATH (agent environments)</h2>
      <p>
        If your agent runtime launches hooks with a restricted <code>PATH</code>,
        install hooks with absolute <code>node</code> and CLI paths:
      </p>
      <pre><code>{`npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --hook-command absolute`}</code></pre>
      <Caution title="Codex trust">
        Codex may require you to approve updated hooks in Codex settings before they
        run. <code>setup</code> installs the hooks and prints a reminder, but does{" "}
        <strong>not</strong> modify Codex trust state directly.
      </Caution>

      <h2>From a local checkout</h2>
      <pre><code>{`corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup`}</code></pre>

      <h2>Compatibility alias</h2>
      <p>
        The package also exposes <code>agent-signature</code> as a compatibility
        alias, so old hooks keep working while new installs use{" "}
        <code>agent-presence</code>.
      </p>

      <h2>Next steps</h2>
      <p>
        Head to the <Link to="/guides/quickstart">Quickstart</Link> to see the full
        usage flow, including a terminal replay.
      </p>
    </Doc>
  );
}
