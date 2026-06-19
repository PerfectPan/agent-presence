import { Doc, Note } from "~/components/Doc";
import { AsciinemaPlayer } from "~/components/AsciinemaPlayer";

export function meta() {
  return [{ title: "Token 用量 — Agent Presence" }];
}

export default function ZhTokenUsage() {
  return (
    <Doc
      locale="zh"
      title="Token 用量"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a> 与 <a href="https://github.com/PerfectPan/agent-presence">rfcs/token-usage-stats.md</a>(英文为单一真相来源)</>
      }
    >
      <p>
        <code>agent-presence usage</code> 按<strong>自然日窗口</strong>统计 token 消耗,
        思路对标 <a href="https://github.com/ryoppippi/ccusage">ccusage</a>:它<strong>不</strong> hook
        智能体,而是事后扫描本地会话记录。
      </p>
      <pre><code>{`agent-presence usage            # 今日 与 近 7 天 并排展示
agent-presence usage --days 7   # 单个自然日窗口
agent-presence usage --json     # 结构化输出，便于脚本处理`}</code></pre>

      <h2>各 source 的记录位置与成本算法</h2>
      <table>
        <thead><tr><th>Source</th><th>会话记录</th><th>成本</th></tr></thead>
        <tbody>
          <tr>
            <td><code>claude</code></td>
            <td><code>~/.claude/projects/**/*.jsonl</code>(遵循 <code>CLAUDE_CONFIG_DIR</code>)</td>
            <td>按价格表定价;按 <code>message.id</code> + <code>requestId</code> 去重并保留最后(最大)一次;排除 <code>&lt;synthetic&gt;</code> turn —— 已对照 ccusage 验证</td>
          </tr>
          <tr>
            <td><code>codex</code></td>
            <td><code>~/.codex/sessions/</code> 与 <code>~/.codex/archived_sessions/</code></td>
            <td>按价格表定价;对每会话的累计 <code>total_token_usage</code> 做差分(直接累加每事件的 <code>last_token_usage</code> 会多算约 1.6 倍)</td>
          </tr>
          <tr>
            <td><code>pi</code></td>
            <td><code>~/.pi/agent/sessions/**/*.jsonl</code></td>
            <td>直接使用 Pi 在会话记录里已记下的成本</td>
          </tr>
          <tr>
            <td><code>gemini</code></td>
            <td>—</td>
            <td><strong>不统计</strong>:Gemini 不在本地持久化每条消息的 token 用量</td>
          </tr>
        </tbody>
      </table>
      <Note title="提示">
        token 统计只覆盖 <strong>Claude、Codex、Pi</strong>。Gemini 与 opencode 不参与 token 统计。
        但这五个 source 都会贡献 <strong>presence</strong>。
      </Note>

      <h2>自然日窗口(非滚动)</h2>
      <p>
        N 天窗口覆盖包含今天在内的 N 个本地自然日 ——
        <code>[startOfLocalDay(now) - (N-1)*24h, now)</code>。也就是说 <code>今日</code>(1 天)从
        <strong>本地 0 点</strong>起算、在 <strong>00:00 归零</strong>,而不是像滚动 24h 窗口那样
        随旧活动老化而中途往下掉。
      </p>
      <p>当某个模型不在价格表中时,成本显示为 <code>n/a</code>;token 数量始终精确。</p>

      <h2>价格覆盖</h2>
      <p>默认价格是尽力而为的估算,会随时间漂移;可以按模型(每百万 token 多少美元)覆盖,无需改代码:</p>
      <pre><code>{`// ~/.agent-presence/config.json
{
  "usage": {
    "showInSignature": false,        // 在签名标题后追加 "今日 …"
    "signatureWindowDays": 1,        // 签名 badge 使用的窗口
    "pricing": { "opus": { "input": 15, "output": 75 } }
  }
}`}</code></pre>

      <h2>签名里的用量</h2>
      <p>签名里的用量由渲染模板变量驱动,由你自己拼标签、自己选要展示的窗口:</p>
      <table>
        <thead><tr><th>变量</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td><code>{"{usage}"}</code></td><td>默认窗口(<code>usage.signatureWindowDays</code>,默认 1)的 badge</td></tr>
          <tr><td><code>{"{usage_1d}"}</code></td><td>1 天自然日 badge,例如 <code>2.1M · $4.50</code></td></tr>
          <tr><td><code>{"{usage_7d}"}</code></td><td>7 天自然日 badge —— 任意 <code>{"{usage_Nd}"}</code> 都可用</td></tr>
        </tbody>
      </table>
      <pre><code>{`agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d} · 近7天 {usage_7d}"`}</code></pre>
      <p>
        模板里引用任意 <code>{"{usage*}"}</code> token 都会触发对它所命名的窗口的扫描。零配置方式:把
        <code>usage.showInSignature</code> 设为 <code>true</code>(或
        <code>AGENT_PRESENCE_USAGE_IN_SIGNATURE=1</code>),即可在不动模板的情况下自动追加
        默认窗口(1 天标注为 <code>今日</code>,否则为 <code>近N天</code>)。
      </p>

      <h2>刷新模型(无 cron)</h2>
      <p>
        badge 只在<strong>会话边界事件</strong>(会话开始或结束)时做全量重扫刷新;高频工具事件复用缓存的
        badge,不触发扫描。因为每次扫描读取的是整个窗口,单次刷新总能得到完整、正确的总量 —— 所以只在
        边界刷新即可保持准确,<strong>无需后台定时器或 cron</strong>。
      </p>
      <p>代价是:会话进行中时,badge 反映的是上一次边界时的总量,而非实时进行中的计数。</p>

      <h2>陈旧 badge 守卫</h2>
      <p>
        因为机器空闲或关机时不运行任何进程,缓存 badge 可能比其窗口活得久(例如昨天的 <code>今日</code>
        总量第二天早上仍在显示)。为避免悄悄展示一个已经不对的数字,当某个 badge 的整个窗口自上次计算以来
        已经翻过 —— <code>今日</code> 过一个午夜、<code>近7天</code> 过七天 —— 时,它会渲染成
        <code>—</code>,直到下一次会话边界刷新重新计算。你在模板里写的标签不变,只有数值塌缩为占位符。
      </p>

      <h2>终端回放</h2>
      <p>下方 cast 回放了一次只读的 <code>agent-presence usage</code> 调用,token/cost 数字为<strong>脱敏、示意</strong>值。</p>
      <AsciinemaPlayer src="/casts/usage.cast" title="agent-presence usage 回放" />
    </Doc>
  );
}
