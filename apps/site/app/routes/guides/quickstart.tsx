import { Link } from "react-router";
import { Doc } from "~/components/Doc";
import { AsciinemaPlayer } from "~/components/AsciinemaPlayer";

export function meta() {
  return [{ title: "Quickstart — Agent Presence" }];
}

export default function Quickstart() {
  return (
    <Doc
      locale="en"
      title="Quickstart"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>
        </>
      }
    >
      <p>
        This walks through the default <code>magic-builder</code> provider flow. The
        terminal replay below shows only <strong>read-only / sanitized</strong>{" "}
        commands — no credentials are ever recorded.
      </p>

      <h2>The flow</h2>
      <ol>
        <li>Run <code>agent-presence setup</code> (default provider <code>magic-builder</code>).</li>
        <li>Scan the l.garyyang QR code if login is needed; this stores the slot credential.</li>
        <li>When prompted, paste a Magic-Builder token so setup can publish the preview FaaS.</li>
        <li>Let setup install Codex, Claude Code, Gemini CLI, opencode, and platform watchers where supported.</li>
        <li>Run <code>agent-presence url</code>.</li>
        <li>Paste that URL into your Feishu profile signature as a custom link preview.</li>
      </ol>

      <h2>Terminal replay</h2>
      <p>
        The cast below replays the read-only portion of the flow:{" "}
        <code>--help</code>, <code>status</code>, <code>url</code>. Login/credential
        entry is <strong>not</strong> recorded — those steps are interactive and
        would expose secrets.
      </p>
      <AsciinemaPlayer
        src="/casts/quickstart.cast"
        title="agent-presence quickstart replay"
      />

      <h2>The signature URLs</h2>
      <p>
        The default <code>magic-builder</code> URL points at the preview FaaS and
        contains no credentials:
      </p>
      <pre><code>{`https://magic.solutionsuite.cn/r?fid=<faasId>`}</code></pre>
      <p>
        The direct <code>feishu-signature</code> URL (via{" "}
        <code>--provider feishu-signature</code>) contains only an encoded slot
        helper, not credentials:
      </p>
      <pre><code>{`https://l.garyyang.work/?t2=<base62({{slot id="slot_xxx"}})>`}</code></pre>

      <h2>Using the published package without a global install</h2>
      <pre><code>{`npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest url`}</code></pre>

      <h2>Default render output</h2>
      <p>Once an agent starts working, the rendered value updates live:</p>
      <pre><code>{`0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P`}</code></pre>
      <p>
        The value is capped at 200 characters. See{" "}
        <Link to="/guides/presence-semantics">Presence Semantics</Link> and{" "}
        <Link to="/guides/render-templates">Render Templates</Link> to customize the
        wording.
      </p>

      <h2>Next steps</h2>
      <ul>
        <li>Add <Link to="/guides/token-usage">token usage</Link> to the badge.</li>
        <li>Understand <Link to="/guides/presence-semantics">how presence is counted</Link>.</li>
      </ul>
    </Doc>
  );
}
