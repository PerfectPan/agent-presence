import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "RFC — Agent Presence" }];
}

export default function ZhRfcs() {
  return (
    <Doc
      locale="zh"
      title="RFC"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">rfcs/</a> 目录(英文为单一真相来源)</>
      }
    >
      <p>
        仓库在 <code>rfcs/</code> 下保存实质性的设计提案。以下是对用户有影响的、当前已接受/已决定的 RFC。
      </p>

      <h2>Token 用量统计 —— <code>rfcs/token-usage-stats.md</code>(Accepted)</h2>
      <p>
        presence 管道告诉你<em>哪些</em>智能体在工作,但没说<em>消耗了多少</em>。本 RFC 引入了
        <code>agent-presence usage</code> 与签名用量 badge。
      </p>
      <p><strong>设计:</strong></p>
      <ul>
        <li>事后扫描会话记录(<a href="https://github.com/ryoppippi/ccusage">ccusage</a> 思路),<strong>不是</strong> hook 负载 —— 生命周期事件不带 token 计数。</li>
        <li>滚动窗口<strong>最初发布过,后被替换</strong>为自然日窗口。N 天窗口覆盖包含今天在内的 N 个本地自然日:<code>[startOfLocalDay(now) - (N-1)*24h, now)</code>。</li>
        <li>各 source 扫描规则:Claude 保留最后(最大)去重(修正约 3.8% 少计);Codex 累计差分(避免约 1.6 倍多计);Pi 信任其自记成本。Gemini 刻意缺席 —— 它不在本地持久化每条消息的 token 用量。</li>
        <li>定价是静态、可覆盖的 USD/MTok 表,按模型子串匹配(最长匹配优先)。未知模型 → <code>null</code> 成本,token 仍精确。</li>
        <li>badge 只在<strong>会话边界事件</strong>时刷新;单次扫描读整个窗口,无需 cron/定时器。</li>
      </ul>
      <p>
        <strong>被否决的备选:</strong>从 hook 负载读 token 计数(事件不带用量);自然日 <code>daily</code> 分组被重新考虑并在 0.6.0 <strong>采纳</strong>;
        实时定价源被推迟(静态表避免热路径上的网络依赖)。
      </p>

      <h2>Linux 电源/session watcher —— <code>rfcs/linux-watcher.md</code>(Skipped)</h2>
      <p>
        macOS 装了 LaunchAgent power watcher;Linux 的等价物被<strong>调研后跳过</strong>。
        TTL 清理(3 分钟)已覆盖主要故障模式(智能体进程退出但没发 finish hook)。
      </p>
      <p><strong>为何跳过:</strong></p>
      <ol>
        <li>systemd user service 行为在各发行版间不一致。</li>
        <li>会话 D-Bus bus 在 headless/SSH/容器运行时不可用。</li>
        <li>部分发行版默认禁用 systemd user 实例(或需要 <code>linger</code>)。</li>
        <li>即便有 logind 信号,watcher 也无法覆盖 TTL 覆盖不到的所有情况。</li>
        <li>测试矩阵会显著膨胀,相对 TTL 无明显安全收益。</li>
      </ol>
      <p>
        <strong>何时重新考虑:</strong>systemd user 实例与轻量 D-Bus 库在目标发行版上可靠存在;
        有简单的安装/卸载路径;休眠/唤醒 + 锁屏/解锁测试覆盖至少两个主流发行版。
      </p>

      <h2>默认 provider:magic-builder —— <code>rfcs/default-provider-magic-builder.md</code>(Accepted)</h2>
      <p>
        记录了把 <code>DEFAULT_PROVIDER_ID</code> 从 <code>feishu-signature</code> 翻转为
        <code>magic-builder</code> 的决定。推送/写入路径与 provider 无关,始终写 l.garyyang slot;
        默认值只影响 <code>setup</code> / <code>url</code> / <code>status --remote</code> 指向哪个预览 URL。
        现有安装不受影响(login 会持久化显式 <code>provider</code>)。
      </p>
    </Doc>
  );
}
