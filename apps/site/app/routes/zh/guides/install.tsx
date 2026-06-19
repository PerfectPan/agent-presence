import { Link } from "react-router";
import { Doc, Note, Caution } from "~/components/Doc";

export function meta() {
  return [{ title: "安装 — Agent Presence" }];
}

export default function ZhInstall() {
  return (
    <Doc
      locale="zh"
      title="安装"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a>(英文为单一真相来源)</>
      }
    >
      <p>
        <code>@rivus/agent-presence</code> 支持 <strong>macOS 与 Linux</strong>。
        CLI 和安装脚本会检测不支持的平台并给出明确错误;<strong>Windows 暂不支持</strong>。
      </p>
      <table>
        <thead>
          <tr><th>平台</th><th>凭据</th><th>电源 watcher</th></tr>
        </thead>
        <tbody>
          <tr><td>macOS</td><td>Keychain</td><td>安装 LaunchAgent power watcher</td></tr>
          <tr><td>Linux</td><td>secret-tool / libsecret</td><td><strong>跳过</strong> —— 依赖 TTL 清理过期 session</td></tr>
        </tbody>
      </table>

      <h2>前置要求</h2>
      <ul>
        <li><strong>Node</strong> {">=20"}</li>
        <li><strong>pnpm</strong> {">=11.1.1"}(通过 <code>packageManager: pnpm@11.1.1</code> 固定)</li>
      </ul>

      <h2>从包仓库全局安装</h2>
      <pre><code>{`pnpm add -g @rivus/agent-presence
agent-presence setup`}</code></pre>
      <p>
        默认 provider 是 <code>magic-builder</code>,所以不带参数的命令都指向它。首次
        <code>setup</code> 会先跑 l.garyyang 扫码登录(保存 slot 凭据),再提示你粘贴
        一个 Magic-Builder token 用于发布预览 FaaS。
      </p>
      <Note title="提示">
        想改用 <code>l.garyyang.work</code> 直连预览(无需 Magic-Builder token),加
        <code>--provider feishu-signature</code>。
      </Note>

      <h2>不全局安装</h2>
      <pre><code>{`npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup`}</code></pre>
      <p>
        通过 <code>npx</code> 运行时,安装的 hook 会使用包的<strong>固定已发布版本</strong>,
        而非浮动的 <code>latest</code> 或全局 <code>agent-presence</code> 二进制。
      </p>

      <h2>PATH 受限的智能体环境</h2>
      <p>若智能体运行时启动 hook 时 <code>PATH</code> 很窄,用绝对路径安装 hook:</p>
      <pre><code>{`npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@latest setup --hook-command absolute`}</code></pre>
      <Caution title="Codex 信任">
        Codex 可能要求你在 Codex 设置中批准更新后的 hook。<code>setup</code> 会安装 hook
        并打印提醒,但<strong>不会</strong>直接修改 Codex 的信任状态。
      </Caution>

      <h2>从本地仓库安装</h2>
      <pre><code>{`corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm link --global
agent-presence setup`}</code></pre>

      <h2>兼容别名</h2>
      <p>
        包也暴露 <code>agent-signature</code> 作为兼容别名,旧 hook 可继续工作,新安装默认用
        <code>agent-presence</code>。
      </p>

      <h2>下一步</h2>
      <p>前往 <Link to="/zh/guides/quickstart">快速上手</Link> 查看完整流程,含终端回放。</p>
    </Doc>
  );
}
