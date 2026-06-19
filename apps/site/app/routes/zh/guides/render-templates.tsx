import { Link } from "react-router";
import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "渲染模板 — Agent Presence" }];
}

export default function ZhRenderTemplates() {
  return (
    <Doc
      locale="zh"
      title="渲染模板"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a>(英文为单一真相来源)</>
      }
    >
      <p>
        渲染的签名值使用三个模板 —— 零活跃、单个活跃、多个活跃各一个。值最长 <strong>200 字符</strong>。
      </p>

      <h2>配置模板</h2>
      <pre><code>{`agent-presence config render \\
  --zero "AI 牛马下班了" \\
  --one "{total} 个 AI 牛马正在搬砖 | {details}" \\
  --many "{total} 个 AI 牛马并行搬砖 | {details}"`}</code></pre>

      <h2>变量</h2>
      <h3>Presence</h3>
      <table>
        <thead><tr><th>变量</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td><code>{"{total}"}</code></td><td>活跃智能体数量</td></tr>
          <tr><td><code>{"{details}"}</code></td><td>按 source 分组的计数,例如 <code>codex 1 · claude 1</code></td></tr>
        </tbody>
      </table>

      <h3>Token 用量</h3>
      <table>
        <thead><tr><th>变量</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td><code>{"{usage}"}</code></td><td>默认窗口(<code>usage.signatureWindowDays</code>,默认 1)的 badge</td></tr>
          <tr><td><code>{"{usage_1d}"}</code></td><td>1 天自然日 badge,例如 <code>2.1M · $4.50</code></td></tr>
          <tr><td><code>{"{usage_7d}"}</code></td><td>7 天自然日 badge —— 任意 <code>{"{usage_Nd}"}</code> 都可用</td></tr>
        </tbody>
      </table>
      <p>窗口语义见 <Link to="/zh/guides/token-usage">Token 用量</Link>。</p>

      <h2>组合用量 + presence</h2>
      <pre><code>{`agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d} · 近7天 {usage_7d}"`}</code></pre>
      <p>模板里引用任意 <code>{"{usage*}"}</code> token 都会触发对它所命名的窗口的扫描。</p>

      <h2>环境变量覆盖</h2>
      <pre><code>{`export AGENT_PRESENCE_RENDER_ZERO="AI 牛马暂未开工"
export AGENT_PRESENCE_RENDER_ONE="{total} 个 AI 牛马正在搬砖 | {details}"
export AGENT_PRESENCE_RENDER_MANY="{total} 个 AI 牛马并行搬砖 | {details}"`}</code></pre>
      <p>旧的 <code>AGENT_SIGNATURE_*</code> 环境变量名仍被接受。</p>

      <h2>默认渲染输出</h2>
      <pre><code>{`0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P`}</code></pre>
    </Doc>
  );
}
