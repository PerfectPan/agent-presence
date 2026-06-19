import { Link } from "react-router";
import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "架构 — Agent Presence" }];
}

export default function ZhArchitecture() {
  return (
    <Doc
      locale="zh"
      title="架构"
      source={
        <><a href="https://github.com/PerfectPan/agent-presence">docs/architecture.md</a>(权威,英文为单一真相来源)</>
      }
    >
      <p>
        <code>@rivus/agent-presence</code> 把本机编码智能体的生命周期事件转成飞书签名链接预览值。
        重要的边界是:它基于<strong>智能体 hook</strong>建模活跃工作,而非进程扫描。
      </p>

      <h2>管道</h2>
      <pre><code>{`Codex / Claude Code / Gemini CLI / opencode / Pi Coding Agent lifecycle hooks
-> CLI hook normalizer
-> locked JSON state
-> TTL pruning
-> debounce renderer
-> slot provider update  (始终写入 l.garyyang slot)
-> Feishu signature link preview`}</code></pre>
      <p>两条路径清晰分离:</p>
      <ul>
        <li><strong>交互式路径</strong>:<code>login</code> / <code>setup</code> / <code>config</code> / <code>status</code> / <code>url</code> / <code>update</code> / <code>reset</code> —— 可能用 Clack 提示。</li>
        <li><strong>Hook 路径</strong>:智能体生命周期事件 → 静默 CLI → 本地状态 → 可选 slot 同步。必须<strong>快、有界、非交互、安全</strong>,可被另一个智能体运行时调用。</li>
      </ul>

      <h2>Provider</h2>
      <p>
        默认 provider id 是 <code>magic-builder</code>,建立在 <code>feishu-signature</code> slot 后端之上的预览前端:
      </p>
      <pre><code>{`hooks -> l.garyyang slot (unchanged write path)
                 ^
                 | GET /api/slot/info  (fetched on each preview refresh)
magic-builder FaaS  (published once to magic.solutionsuite.cn/api/faas)
                 ^
                 | Feishu pulls the link preview
signature URL = https://magic.solutionsuite.cn/r?fid=<record_id>`}</code></pre>
      <p>
        slot 值更新始终写入 l.garyyang slot —— hook/更新路径<strong>与 provider 无关</strong>。
        <code>magic-builder</code> 只改变飞书嵌入的是哪个预览 URL。
      </p>

      <h2>配置与状态</h2>
      <p>
        provider 专属选项放在 provider id 下,这样通用 presence 模型不需要飞书专属命名。状态以 JSON 存储,
        由锁文件保护,分两层:<code>sessions</code>(事件派生的真相)与
        <code>lastSlotUpdateAt</code> / <code>lastValue</code>(渲染器/provider 防抖检查点)。
      </p>

      <h2>Hook 归一化</h2>
      <table>
        <thead><tr><th>事件</th><th>结果</th></tr></thead>
        <tbody>
          <tr><td>start 事件</td><td><code>running</code></td></tr>
          <tr><td>heartbeat 事件</td><td><code>running</code>,刷新 <code>lastHeartbeatAt</code></td></tr>
          <tr><td>finish 事件</td><td><code>finished</code></td></tr>
          <tr><td>idle 事件</td><td><code>finished</code></td></tr>
        </tbody>
      </table>
      <p>
        Codex hook 始终输出 <code>{"{}"}</code>(透传);Claude Code、Gemini CLI、opencode、Pi 运行 <code>--silent</code>。
      </p>

      <h2>会话状态机</h2>
      <p>
        三种状态 —— 完整转换表与图见{" "}
        <Link to="/zh/guides/presence-semantics">Presence 语义</Link>。默认 TTL 为 <strong>3 分钟</strong>。
      </p>

      <h2>防抖与 provider 更新</h2>
      <p>
        hook 立即更新本地状态;渲染器把新渲染值与 <code>lastValue</code> / <code>lastSlotUpdateAt</code> 比较。
        常规更新遵循防抖间隔;<code>update --force</code> 与 <code>reset --force</code> 绕过它。
        网络 I/O 保持在状态变更锁<strong>之外</strong>,这样慢 provider 请求不会阻塞无关的生命周期写入。
      </p>

      <h2>信任边界</h2>
      <ul>
        <li>凭据放在 Keychain(macOS)、libsecret(Linux)或环境变量 —— <strong>绝不</strong>进 git、签名 URL、日志、hook 文件或本地配置文件。</li>
        <li>Linux 上,若环境变量和 libsecret 都不可用,凭据操作会以明确错误退出(无明文 fallback)。</li>
        <li>provider 只写 slot 值变更,不写飞书个人资料字段。</li>
        <li><code>magic-builder</code> provider 是"凭据永不离开本机"规则的唯一刻意例外:它发布的 FaaS 嵌入了 l.garyyang slot bearer,以便在 <code>magic.solutionsuite.cn</code> 上读取 slot。需要显式操作者动作;嵌入的只是低敏感度 slot bearer,绝不包含 magic-builder token。</li>
      </ul>

      <h2>故障模型</h2>
      <table>
        <thead><tr><th>故障</th><th>预期行为</th></tr></thead>
        <tbody>
          <tr><td>智能体退出但没发 finish hook</td><td>session 在 TTL 后过期。</td></tr>
          <tr><td>hook 命令失败</td><td>编码智能体继续;Codex 收到 <code>{"{}"}</code>。</td></tr>
          <tr><td>provider 返回 429</td><td>本地状态仍正确;下次非防抖更新可同步。</td></tr>
          <tr><td>合盖/睡眠</td><td>macOS power watcher 把本地和远端重置为 0。Linux TTL 清理 session。</td></tr>
          <tr><td>突然断电</td><td>唤醒重置(macOS)+ TTL 清理陈旧 session。</td></tr>
          <tr><td>Keychain 不可用</td><td>显式环境变量可提供 token + slot id。</td></tr>
          <tr><td>Linux 无 <code>secret-tool</code></td><td>凭据操作以明确安装提示退出;环境变量仍可用。</td></tr>
          <tr><td><code>npx</code> 缓存在 setup 后消失</td><td>托管 hook 仍能工作 —— 它们指向稳定的运行时/shim。</td></tr>
          <tr><td>Codex hook 存在但未受信任</td><td>setup 打印提醒;在 Codex 设置中批准。</td></tr>
        </tbody>
      </table>

      <h2>深入阅读</h2>
      <p>
        完整幂等表、可观测性模型、Codex hook 信任与扩展点,见仓库的{" "}
        <a href="https://github.com/PerfectPan/agent-presence">docs/architecture.md</a>。
      </p>
    </Doc>
  );
}
