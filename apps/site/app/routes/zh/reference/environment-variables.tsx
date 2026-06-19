import { Doc, Caution } from "~/components/Doc";

export function meta() {
  return [{ title: "环境变量 — Agent Presence" }];
}

export default function ZhEnvVars() {
  return (
    <Doc
      locale="zh"
      title="环境变量"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a>(英文为单一真相来源)</>
      }
    >
      <p>凭据绝不写入 git、签名 URL、日志、hook 文件或本地配置文件。</p>

      <h2>通用与渲染</h2>
      <table>
        <thead><tr><th>变量</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td><code>AGENT_PRESENCE_PROVIDER</code></td><td>覆盖 provider id(<code>magic-builder</code> / <code>feishu-signature</code>)</td></tr>
          <tr><td><code>AGENT_PRESENCE_RENDER_ZERO</code></td><td>零活跃渲染模板</td></tr>
          <tr><td><code>AGENT_PRESENCE_RENDER_ONE</code></td><td>单个活跃渲染模板</td></tr>
          <tr><td><code>AGENT_PRESENCE_RENDER_MANY</code></td><td>多个活跃渲染模板</td></tr>
          <tr><td><code>AGENT_PRESENCE_USAGE_IN_SIGNATURE</code></td><td>设为 <code>1</code> 自动追加默认用量窗口</td></tr>
          <tr><td><code>AGENT_PRESENCE_USAGE_WINDOW_DAYS</code></td><td>覆盖 <code>usage.signatureWindowDays</code></td></tr>
          <tr><td><code>AGENT_PRESENCE_LOG_FILE</code></td><td>覆盖日志路径(默认 <code>~/.agent-presence/agent-presence.log</code>)</td></tr>
          <tr><td><code>AGENT_PRESENCE_HOME</code></td><td>覆盖本地 home 目录</td></tr>
          <tr><td><code>CLAUDE_CONFIG_DIR</code></td><td>Claude 会话记录扫描遵循此变量</td></tr>
        </tbody>
      </table>
      <p>
        遗留别名 <code>AGENT_SIGNATURE_*</code>(如 <code>AGENT_SIGNATURE_PROVIDER</code>、
        <code>AGENT_SIGNATURE_HOME</code>、<code>AGENT_SIGNATURE_LOG_FILE</code>)仍被接受。
      </p>

      <h2>feishu-signature 凭据与预览</h2>
      <table>
        <thead><tr><th>变量</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td><code>AGENT_PRESENCE_TOKEN</code></td><td>slot bearer token</td></tr>
          <tr><td><code>AGENT_PRESENCE_SLOT_ID</code></td><td>slot id(如 <code>slot_xxx</code>)</td></tr>
          <tr><td><code>AGENT_PRESENCE_FEISHU_SIGNATURE_BASE_URL</code></td><td>覆盖 <code>https://l.garyyang.work</code></td></tr>
          <tr><td><code>AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_BASE_URL</code></td><td>预览 base URL</td></tr>
          <tr><td><code>AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_IMAGE_KEY</code></td><td>链接预览 image key</td></tr>
          <tr><td><code>AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_TARGET_URL</code></td><td>链接预览 target URL</td></tr>
        </tbody>
      </table>

      <h2>magic-builder</h2>
      <table>
        <thead><tr><th>变量</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td><code>MAGIC_TOKEN</code></td><td>发布 token(解析顺序中优先级最高)</td></tr>
          <tr><td><code>AGENT_PRESENCE_MAGIC_BUILDER_BASE_URL</code></td><td>覆盖 <code>magic.solutionsuite.cn</code></td></tr>
          <tr><td><code>AGENT_PRESENCE_MAGIC_BUILDER_FAAS_ID</code></td><td>固定已有 FaaS record id(<code>rec_...</code>)</td></tr>
          <tr><td><code>AGENT_PRESENCE_MAGIC_BUILDER_FAAS_NAME</code></td><td>覆盖默认 <code>agent_presence_preview</code></td></tr>
          <tr><td><code>AGENT_PRESENCE_MAGIC_BUILDER_FALLBACK_TITLE</code></td><td>slot 读取失败时渲染</td></tr>
        </tbody>
      </table>
      <p>
        <strong>magic-builder token 解析顺序:</strong> <code>MAGIC_TOKEN</code> 环境变量 →
        OS keyring(<code>agent-presence:magic-builder</code>)→ <code>~/.magic-token</code> →
        <code>&lt;cwd&gt;/.magic-token</code>。明文 <code>~/.magic-token</code> 文件为兼容 skill-pack 会被读取,
        但本 CLI <strong>从不写入</strong>。
      </p>

      <h2>凭据解析顺序</h2>
      <table>
        <thead><tr><th>平台</th><th>顺序</th></tr></thead>
        <tbody>
          <tr><td>macOS</td><td>Keychain(默认)→ 环境变量(自动化覆盖)</td></tr>
          <tr><td>Linux</td><td>libsecret(<code>secret-tool</code>)→ 环境变量。<strong>无明文 fallback</strong> —— 若都不可用,凭据操作会以明确错误退出。</td></tr>
        </tbody>
      </table>
      <Caution>
        凭据不得嵌入 hook 命令、生成的签名 URL、README 示例、测试或 Changesets。
      </Caution>
    </Doc>
  );
}
