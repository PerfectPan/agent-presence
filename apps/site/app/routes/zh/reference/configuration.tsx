import { Link } from "react-router";
import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "配置 — Agent Presence" }];
}

export default function ZhConfiguration() {
  return (
    <Doc
      locale="zh"
      title="配置"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a>(英文为单一真相来源)</>
      }
    >
      <h2>位置</h2>
      <p>所有持久本地配置、状态、日志都在 <code>~/.agent-presence/</code> 下:</p>
      <pre><code>{`~/.agent-presence/
  config.json              provider/render/usage 配置
  state.json               本地 JSON 状态
  agent-presence.log       hook + 命令诊断
  runtime/                 托管 hook 运行时（setup 生成）
  bin/                     稳定 hook shim（setup 生成）`}</code></pre>
      <p>
        配置文件是 <strong>JSONC</strong>(允许注释)。当新配置不存在时,仍会读取遗留路径
        <code>~/.codex/agent-signature/config.json</code>。
      </p>
      <p>重置为空:</p>
      <pre><code>{`printf '{}\\n' > ~/.agent-presence/config.json`}</code></pre>

      <h2>Provider</h2>
      <p>
        默认 provider id 是 <code>magic-builder</code>(建立在 <code>feishu-signature</code> slot 后端之上的预览前端)。
        用 <code>--provider</code> 逐命令覆盖,或持久化设置:
      </p>
      <pre><code>{`{
  "provider": "magic-builder"
}`}</code></pre>
      <p><code>feishu-signature</code> 链接预览字段:</p>
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
      <p><code>magic-builder</code> 存储已发布 FaaS 的 record id:</p>
      <pre><code>{`{
  "providers": {
    "magic-builder": {
      "faasId": "rec_xxx"
    }
  }
}`}</code></pre>

      <h2>渲染模板</h2>
      <pre><code>{`{
  "render": {
    "zero": "AI 牛马暂未开工",
    "one": "{total} 个 AI 牛马正在搬砖 | {details}",
    "many": "{total} 个 AI 牛马并行搬砖 | {details}"
  }
}`}</code></pre>

      <h2>用量</h2>
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
        <thead><tr><th>键</th><th>类型</th><th>默认</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td><code>usage.showInSignature</code></td><td>boolean</td><td><code>false</code></td><td>自动追加默认窗口 badge</td></tr>
          <tr><td><code>usage.signatureWindowDays</code></td><td>number</td><td><code>1</code></td><td><code>{"{usage}"}</code> 变量使用的窗口</td></tr>
          <tr><td><code>usage.pricing.&lt;model&gt;</code></td><td><code>{"{ input, output }"}</code></td><td>内置表</td><td>每百万 token 美元覆盖</td></tr>
        </tbody>
      </table>
      <p>未知模型成本为 <code>n/a</code>;token 数量始终精确。</p>

      <h2>路径覆盖</h2>
      <p>
        本地 home 可通过 <code>AGENT_PRESENCE_HOME</code> 或遗留的 <code>AGENT_SIGNATURE_HOME</code> 覆盖。
        单个文件路径也可通过专用环境变量覆盖(见{" "}
        <Link to="/zh/reference/environment-variables">环境变量</Link>)。
      </p>
    </Doc>
  );
}
