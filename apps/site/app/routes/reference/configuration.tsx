import { Link } from "react-router";
import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "Configuration — Agent Presence" }];
}

export default function Configuration() {
  return (
    <Doc
      locale="en"
      title="Configuration"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>
        </>
      }
    >
      <h2>Location</h2>
      <p>All durable local config, state, and logs live under <code>~/.agent-presence/</code>:</p>
      <pre><code>{`~/.agent-presence/
  config.json              provider/render/usage configuration
  state.json               local JSON state
  agent-presence.log       hook + command diagnostics
  runtime/                 managed hook runtime (materialized by setup)
  bin/                     stable hook shims (materialized by setup)`}</code></pre>
      <p>
        The config file is <strong>JSONC</strong> (comments allowed). Legacy path{" "}
        <code>~/.codex/agent-signature/config.json</code> is still read when the new
        config does not exist.
      </p>
      <p>Reset to empty:</p>
      <pre><code>{`printf '{}\\n' > ~/.agent-presence/config.json`}</code></pre>

      <h2>Provider</h2>
      <p>
        The default provider id is <code>magic-builder</code> (a preview front-end
        over the <code>feishu-signature</code> slot backend). Override per-command
        with <code>--provider</code>, or set it persistently:
      </p>
      <pre><code>{`{
  "provider": "magic-builder"
}`}</code></pre>
      <p><code>feishu-signature</code> link-preview fields:</p>
      <pre><code>{`{
  "providers": {
    "feishu-signature": {
      "baseUrl": "https://l.garyyang.work",
      "previewBaseUrl": "https://l.garyyang.work/",
      "imageKey": "img_xxx",
      "targetUrl": "https://example.com"
    }
  }
}`}</code></pre>
      <p><code>magic-builder</code> stores the published FaaS record id:</p>
      <pre><code>{`{
  "providers": {
    "magic-builder": {
      "faasId": "rec_xxx"
    }
  }
}`}</code></pre>

      <h2>Render templates</h2>
      <pre><code>{`{
  "render": {
    "zero": "AI 牛马暂未开工",
    "one": "{total} 个 AI 牛马正在搬砖 | {details}",
    "many": "{total} 个 AI 牛马并行搬砖 | {details}"
  }
}`}</code></pre>

      <h2>Usage</h2>
      <pre><code>{`{
  "usage": {
    "showInSignature": false,
    "signatureWindowDays": 1,
    "pricing": {
      "opus": { "input": 15, "output": 75 }
    }
  }
}`}</code></pre>
      <table>
        <thead><tr><th>Key</th><th>Type</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>usage.showInSignature</code></td><td>boolean</td><td><code>false</code></td><td>auto-append the default window badge</td></tr>
          <tr><td><code>usage.signatureWindowDays</code></td><td>number</td><td><code>1</code></td><td>window the <code>{"{usage}"}</code> variable uses</td></tr>
          <tr><td><code>usage.pricing.&lt;model&gt;</code></td><td><code>{"{ input, output }"}</code></td><td>built-in table</td><td>USD per million tokens override</td></tr>
        </tbody>
      </table>
      <p>Unknown models yield <code>n/a</code> cost; token counts are always exact.</p>

      <h2>Path overrides</h2>
      <p>
        The local home can be overridden via <code>AGENT_PRESENCE_HOME</code> or the
        legacy <code>AGENT_SIGNATURE_HOME</code>. Individual file paths can also be
        overridden via dedicated env vars (see{" "}
        <Link to="/reference/environment-variables">Environment variables</Link>).
      </p>
    </Doc>
  );
}
