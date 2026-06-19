import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "卸载 — Agent Presence" }];
}

export default function ZhUninstall() {
  return (
    <Doc
      locale="zh"
      title="卸载"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a>(英文为单一真相来源)</>
      }
    >
      <p>
        <code>agent-presence setup</code> 会安装 Codex、Claude Code、Gemini CLI、opencode、Pi 扩展以及
        macOS power watcher 的 hook。卸载是<strong>幂等</strong>的 —— 即使机器上没装 hook 也能干净成功。
      </p>

      <h2>默认卸载(保留凭据)</h2>
      <pre><code>{`agent-presence uninstall`}</code></pre>
      <p>
        默认卸载会<strong>保留凭据、本地状态和 provider 配置</strong>,后续可以用
        <code>agent-presence setup --skip-login</code> 重新安装而不重新扫码。
      </p>
      <p>它会移除:</p>
      <ul>
        <li>托管的 Codex hooks(<code>~/.codex/hooks.json</code>)</li>
        <li>托管的 Claude Code hooks(<code>~/.claude/settings.json</code>)</li>
        <li>托管的 Gemini CLI hooks(<code>~/.gemini/settings.json</code>)</li>
        <li>托管的 opencode plugin(<code>~/.config/opencode/plugins/agent-presence.js</code>)</li>
        <li>托管的 Pi Coding Agent 扩展(<code>~/.pi/agent/extensions/agent-presence.ts</code>)</li>
        <li>macOS power watcher(Linux 跳过)</li>
      </ul>

      <h2>清理登录凭据和 slot 配置</h2>
      <pre><code>{`agent-presence uninstall --credentials`}</code></pre>

      <h2>全部清理</h2>
      <pre><code>{`agent-presence uninstall --all`}</code></pre>
      <p>移除 hook、凭据、slot 配置、本地状态和托管运行时。</p>

      <h2>手动 macOS 清理(等效)</h2>
      <pre><code>{`security delete-generic-password -s 'agent-signature:l-garyyang' -a token 2>/dev/null || true
security delete-generic-password -s 'agent-signature:l-garyyang' -a slotId 2>/dev/null || true
security delete-generic-password -s 'agent-signature-slot-credential' -a "\${USER:-agent-presence}" 2>/dev/null || true
printf '{}\\n' > ~/.agent-presence/config.json
# 旧版本用的遗留配置路径：
printf '{}\\n' > ~/.codex/agent-signature/config.json`}</code></pre>

      <h2>手动包脚本</h2>
      <p>这些在本地 checkout 里仍可用:</p>
      <pre><code>{`pnpm run install:all-hooks
pnpm run uninstall:all-hooks
pnpm run install:shutdown-watcher
pnpm run uninstall:shutdown-watcher`}</code></pre>
    </Doc>
  );
}
