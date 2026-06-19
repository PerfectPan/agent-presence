import { Link } from "react-router";
import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "Presence 语义 — Agent Presence" }];
}

export default function ZhPresenceSemantics() {
  return (
    <Doc
      locale="zh"
      title="Presence 语义"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a> 与 <a href="https://github.com/PerfectPan/agent-presence">docs/architecture.md</a>(英文为单一真相来源)</>
      }
    >
      <p>
        这里统计的是<strong>正在工作的智能体</strong>,不是"打开了多少个终端窗口"。Presence 来自
        智能体生命周期 hook —— 绝不扫描进程或终端窗口。
      </p>

      <h2>状态机</h2>
      <p>
        三种状态:<code>running</code>(明确的本地工作证据)、<code>finished</code>(明确的结束/空闲事件结束
        了本轮)、<code>expired</code>(TTL 推断的不活跃,默认 <strong>3 分钟</strong>)。
      </p>
      <pre><code>{`SessionStart / UserPromptSubmit / PreToolUse / PostToolUse -> running / heartbeat
Pi before_agent_start / turn_start / tool_execution_*      -> running / heartbeat
Stop / SessionEnd / session.idle / agent_end / session_shutdown -> finished
No heartbeat for 3 minutes                                    -> expired
Expired + later live heartbeat                                -> running again
Laptop sleep / lid close / screen sleep                       -> reset to 0
Wake                                                          -> reset to 0 again`}</code></pre>
      <p>
        <code>finished</code> 是明确结束,会忽略普通迟到 heartbeat;<code>expired</code> 只是 TTL 推断的不活跃,
        同一个 session 后续又有真实 heartbeat 时可以恢复为 running。
      </p>

      <h2>状态图</h2>
      <p>
        下图是项目权威的状态机,原样复用自 <code>docs/assets/presence-state-machine.svg</code>。
      </p>
      <p>
        <img
          src="/assets/presence-state-machine.svg"
          alt="Agent Presence 会话状态机:missing、running(计数中)、expired(不活跃)、finished(不活跃)、reset 五种状态及带编号的转换。"
          style={{ width: "100%", maxWidth: "60rem" }}
        />
      </p>

      <h2>关键区别</h2>
      <ul>
        <li>
          <strong><code>finished</code></strong> 来自明确的生命周期事件,在本轮停止后保护状态免受迟到的异步 hook 流量干扰。
        </li>
        <li>
          <strong><code>expired</code></strong> 只是 inactive 推断,所以同一 session 后续真实 heartbeat 可以重新激活它。
        </li>
      </ul>
      <p>只有 TTL 内的 <code>running</code> session 才计入渲染的活跃计数。</p>

      <h2>Pi 的特殊语义</h2>
      <p>
        对 Pi 而言,单纯打开 <code>pi</code> TUI <strong>不算</strong> active:只有当 Pi 触发
        <code>before_agent_start</code>(用户真正提交任务时)才开始计数。这避免"Pi 开着但没干活"被误统计。
      </p>

      <h2>默认渲染</h2>
      <pre><code>{`0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P`}</code></pre>
      <p>
        渲染值最长 <strong>200 字符</strong>。要改文案见{" "}
        <Link to="/zh/guides/render-templates">渲染模板</Link>。
      </p>

      <h2>无进程扫描的恢复</h2>
      <p>这套模型给出两条无需扫描进程的恢复路径:</p>
      <ol>
        <li>漏掉的 finish hook 由 <strong>TTL 过期</strong>清理。</li>
        <li>长 session 在下一次<strong>真实 heartbeat</strong>时重新激活。</li>
      </ol>
      <p>
        合盖/睡眠/唤醒会执行 <code>agent-presence reset --force --silent</code>(macOS power watcher)。
        Linux 跳过 watcher,3 分钟 TTL 清理过期 session。
      </p>
    </Doc>
  );
}
