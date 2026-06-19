import { Link } from "react-router";
import { Doc } from "~/components/Doc";
import { AsciinemaPlayer } from "~/components/AsciinemaPlayer";

export function meta() {
  return [{ title: "快速上手 — Agent Presence" }];
}

export default function ZhQuickstart() {
  return (
    <Doc
      locale="zh"
      title="快速上手"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a>(英文为单一真相来源)</>
      }
    >
      <p>
        下面走默认的 <code>magic-builder</code> provider 流程。下方终端回放只演示
        <strong>只读 / 脱敏</strong>命令 —— 绝不出现真实凭据。
      </p>

      <h2>流程</h2>
      <ol>
        <li>运行 <code>agent-presence setup</code>(默认 provider 为 <code>magic-builder</code>)。</li>
        <li>需要登录时扫 l.garyyang 二维码,保存 slot 凭据。</li>
        <li>出现提示时粘贴 Magic-Builder token,让 setup 发布预览 FaaS。</li>
        <li>让 setup 安装 Codex、Claude Code、Gemini CLI、opencode 及平台支持的 watcher。</li>
        <li>运行 <code>agent-presence url</code>。</li>
        <li>把该 URL 粘贴到飞书个人资料签名的自定义链接预览中。</li>
      </ol>

      <h2>终端回放</h2>
      <p>
        下方 cast 回放了流程的只读部分:<code>--help</code>、<code>status</code>、
        <code>url</code>。登录/凭据输入<strong>不录制</strong> —— 这些步骤是交互式的,
        会暴露密钥。
      </p>
      <AsciinemaPlayer src="/casts/quickstart.cast" title="agent-presence 快速上手回放" />

      <h2>签名 URL</h2>
      <p>默认的 <code>magic-builder</code> URL 指向预览 FaaS,不含任何凭据:</p>
      <pre><code>{`https://magic.solutionsuite.cn/r?fid=<faasId>`}</code></pre>
      <p>
        直连 <code>feishu-signature</code> URL(通过 <code>--provider feishu-signature</code>)只含编码后的
        slot helper,不含凭据:
      </p>
      <pre><code>{`https://l.garyyang.work/?t2=<base62({{slot id="slot_xxx"}})>`}</code></pre>

      <h2>不全局安装使用发布包</h2>
      <pre><code>{`npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup
npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest url`}</code></pre>

      <h2>默认渲染输出</h2>
      <p>智能体开始工作时,渲染值会实时更新:</p>
      <pre><code>{`0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P`}</code></pre>
      <p>
        渲染值最长 200 字符。查看{" "}
        <Link to="/zh/guides/presence-semantics">Presence 语义</Link> 与{" "}
        <Link to="/zh/guides/render-templates">渲染模板</Link> 来自定义文案。
      </p>

      <h2>下一步</h2>
      <ul>
        <li>给 badge 加上 <Link to="/zh/guides/token-usage">token 用量</Link>。</li>
        <li>了解 <Link to="/zh/guides/presence-semantics">presence 是怎么计数的</Link>。</li>
      </ul>
    </Doc>
  );
}
