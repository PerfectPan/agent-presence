import { Doc, Caution } from "~/components/Doc";

export function meta() {
  return [{ title: "Environment variables — Agent Presence" }];
}

export default function EnvironmentVariables() {
  return (
    <Doc
      locale="en"
      title="Environment variables"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>
        </>
      }
    >
      <p>
        Credentials are never written to git, the signature URL, logs, hook files,
        or local config files.
      </p>

      <h2>General &amp; rendering</h2>
      <table>
        <thead><tr><th>Variable</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>AGENT_PRESENCE_PROVIDER</code></td><td>override the provider id (<code>magic-builder</code> / <code>feishu-signature</code>)</td></tr>
          <tr><td><code>AGENT_PRESENCE_RENDER_ZERO</code></td><td>render template for zero active agents</td></tr>
          <tr><td><code>AGENT_PRESENCE_RENDER_ONE</code></td><td>render template for one active agent</td></tr>
          <tr><td><code>AGENT_PRESENCE_RENDER_MANY</code></td><td>render template for many active agents</td></tr>
          <tr><td><code>AGENT_PRESENCE_USAGE_IN_SIGNATURE</code></td><td>set to <code>1</code> to auto-append the default usage window</td></tr>
          <tr><td><code>AGENT_PRESENCE_USAGE_WINDOW_DAYS</code></td><td>override <code>usage.signatureWindowDays</code></td></tr>
          <tr><td><code>AGENT_PRESENCE_LOG_FILE</code></td><td>override the log path (default <code>~/.agent-presence/agent-presence.log</code>)</td></tr>
          <tr><td><code>AGENT_PRESENCE_HOME</code></td><td>override the local home directory</td></tr>
          <tr><td><code>CLAUDE_CONFIG_DIR</code></td><td>honoured by the Claude transcript scanner</td></tr>
        </tbody>
      </table>
      <p>
        Legacy aliases <code>AGENT_SIGNATURE_*</code> (e.g.{" "}
        <code>AGENT_SIGNATURE_PROVIDER</code>, <code>AGENT_SIGNATURE_HOME</code>,{" "}
        <code>AGENT_SIGNATURE_LOG_FILE</code>) are still accepted.
      </p>

      <h2>feishu-signature credentials &amp; preview</h2>
      <table>
        <thead><tr><th>Variable</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>AGENT_PRESENCE_TOKEN</code></td><td>slot bearer token</td></tr>
          <tr><td><code>AGENT_PRESENCE_SLOT_ID</code></td><td>slot id (e.g. <code>slot_xxx</code>)</td></tr>
          <tr><td><code>AGENT_PRESENCE_FEISHU_SIGNATURE_BASE_URL</code></td><td>override <code>https://l.garyyang.work</code></td></tr>
          <tr><td><code>AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_BASE_URL</code></td><td>preview base URL</td></tr>
          <tr><td><code>AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_IMAGE_KEY</code></td><td>link-preview image key</td></tr>
          <tr><td><code>AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_TARGET_URL</code></td><td>link-preview target URL</td></tr>
        </tbody>
      </table>

      <h2>magic-builder</h2>
      <table>
        <thead><tr><th>Variable</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>MAGIC_TOKEN</code></td><td>publish token (highest precedence in resolution order)</td></tr>
          <tr><td><code>AGENT_PRESENCE_MAGIC_BUILDER_BASE_URL</code></td><td>override <code>magic.solutionsuite.cn</code></td></tr>
          <tr><td><code>AGENT_PRESENCE_MAGIC_BUILDER_FAAS_ID</code></td><td>pin an existing FaaS record id (<code>rec_...</code>)</td></tr>
          <tr><td><code>AGENT_PRESENCE_MAGIC_BUILDER_FAAS_NAME</code></td><td>override default <code>agent_presence_preview</code></td></tr>
          <tr><td><code>AGENT_PRESENCE_MAGIC_BUILDER_FALLBACK_TITLE</code></td><td>rendered when the slot read fails</td></tr>
        </tbody>
      </table>
      <p>
        <strong>magic-builder token resolution order:</strong> <code>MAGIC_TOKEN</code>{" "}
        env → OS keyring (<code>agent-presence:magic-builder</code>) →{" "}
        <code>~/.magic-token</code> → <code>&lt;cwd&gt;/.magic-token</code>. The
        plaintext <code>~/.magic-token</code> file is read for skill-pack
        compatibility but is <strong>never written</strong> by this CLI.
      </p>

      <h2>Credential resolution order</h2>
      <table>
        <thead><tr><th>Platform</th><th>Order</th></tr></thead>
        <tbody>
          <tr><td>macOS</td><td>Keychain (default) → environment variables (automation override)</td></tr>
          <tr><td>Linux</td><td>libsecret (<code>secret-tool</code>) → environment variables. <strong>No plaintext fallback</strong> — if neither is available, credential operations fail with a clear error.</td></tr>
        </tbody>
      </table>
      <Caution>
        Credentials must not be embedded in hook commands, generated signature
        URLs, README examples, tests, or Changesets.
      </Caution>
    </Doc>
  );
}
