import { Link } from "react-router";
import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "Render templates — Agent Presence" }];
}

export default function RenderTemplates() {
  return (
    <Doc
      locale="en"
      title="Render templates"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>
        </>
      }
    >
      <p>
        The rendered signature value uses three templates — one for zero active
        agents, one for a single agent, and one for many. The value is capped at{" "}
        <strong>200 characters</strong>.
      </p>

      <h2>Configure templates</h2>
      <pre><code>{`agent-presence config render \\
  --zero "AI 牛马下班了" \\
  --one "{total} 个 AI 牛马正在搬砖 | {details}" \\
  --many "{total} 个 AI 牛马并行搬砖 | {details}"`}</code></pre>

      <h2>Variables</h2>
      <h3>Presence</h3>
      <table>
        <thead><tr><th>Variable</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>{"{total}"}</code></td><td>active agent count</td></tr>
          <tr><td><code>{"{details}"}</code></td><td>grouped source counts, e.g. <code>codex 1 · claude 1</code></td></tr>
        </tbody>
      </table>

      <h3>Token usage</h3>
      <table>
        <thead><tr><th>Variable</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>{"{usage}"}</code></td><td>default-window badge (<code>usage.signatureWindowDays</code>, default 1)</td></tr>
          <tr><td><code>{"{usage_1d}"}</code></td><td>1-day calendar badge, e.g. <code>2.1M · $4.50</code></td></tr>
          <tr><td><code>{"{usage_7d}"}</code></td><td>7-day calendar badge — any <code>{"{usage_Nd}"}</code> works</td></tr>
        </tbody>
      </table>
      <p>
        See <Link to="/guides/token-usage">Token usage</Link> for the window
        semantics.
      </p>

      <h2>Composing usage + presence</h2>
      <pre><code>{`agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d} · 近7天 {usage_7d}"`}</code></pre>
      <p>Referencing any <code>{"{usage*}"}</code> token enables scanning for the windows it names.</p>

      <h2>Environment overrides</h2>
      <pre><code>{`export AGENT_PRESENCE_RENDER_ZERO="AI 牛马暂未开工"
export AGENT_PRESENCE_RENDER_ONE="{total} 个 AI 牛马正在搬砖 | {details}"
export AGENT_PRESENCE_RENDER_MANY="{total} 个 AI 牛马并行搬砖 | {details}"`}</code></pre>
      <p>Legacy <code>AGENT_SIGNATURE_*</code> environment names are still accepted.</p>

      <h2>Default render output</h2>
      <pre><code>{`0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P`}</code></pre>
    </Doc>
  );
}
