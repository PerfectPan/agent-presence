import { Doc, Note } from "~/components/Doc";

export function meta() {
  return [{ title: "命令 — Agent Presence" }];
}

export default function ZhCommands() {
  return (
    <Doc
      locale="zh"
      title="命令"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a>(英文为单一真相来源)</>
      }
    >
      <p>
        不带参数的命令指向默认的 <code>magic-builder</code> provider。加
        <code>--provider feishu-signature</code> 指向 <code>l.garyyang.work</code> 直连预览。
      </p>

      <h2>安装与登录</h2>
      <pre><code>{`agent-presence setup                       # 默认 provider（magic-builder）
agent-presence setup --login               # 强制重新登录
agent-presence setup --skip-login          # 不检查登录，刷新 hook
agent-presence setup --no-hooks            # 跳过安装 hook
agent-presence setup --hook-command absolute  # 绝对 node + CLI 路径（PATH 受限）
agent-presence login --provider feishu-signature  # 交互式扫码登录 slot 后端`}</code></pre>

      <h2>输出命令</h2>
      <pre><code>{`agent-presence url                         # 默认（magic-builder）签名 URL
agent-presence status                      # 脚本安全的本地状态
agent-presence status --remote             # 同时读取远端 slot/预览
agent-presence usage                       # 今日 + 近 7 天
agent-presence usage --days 7              # 单个自然日窗口
agent-presence usage --days 1 --json       # 结构化输出`}</code></pre>

      <h2>写入 / 重置</h2>
      <pre><code>{`agent-presence update --force              # 推送渲染更新（脚本安全，绕过防抖）
agent-presence reset --force               # presence 重置为 0
agent-presence reset --force --silent      # power watcher 执行的命令`}</code></pre>

      <h2>卸载</h2>
      <pre><code>{`agent-presence uninstall                   # 移除 hook/watcher，保留凭据 + 状态
agent-presence uninstall --credentials     # 同时清理登录 + slot 配置
agent-presence uninstall --all             # hook + 凭据 + 配置 + 状态 + 托管运行时`}</code></pre>

      <h2>配置</h2>
      <pre><code>{`agent-presence config show
agent-presence config render --zero "..." --one "..." --many "..."
agent-presence config provider feishu-signature \\
  --base-url "https://l.garyyang.work" \\
  --preview-base-url "https://l.garyyang.work/" \\
  --image-key "img_xxx" \\
  --target-url "https://example.com"`}</code></pre>

      <h2>Hook(直接调用)</h2>
      <p>hook 由 <code>setup</code> 自动安装,也可直接调用:</p>
      <pre><code>{`agent-presence hook --source codex    --event SessionStart
agent-presence hook --source claude   --event SessionStart --silent
agent-presence hook --source gemini   --event SessionStart --silent
agent-presence hook --source opencode --event SessionStart --silent
agent-presence hook --source pi       --event SessionStart --silent
agent-presence hook --source codex    --event Stop`}</code></pre>
      <Note title="Hook 输出">
        hook 命令绝不阻塞编码智能体。<strong>Codex hook 输出 <code>{"{}"}</code></strong>(透传);Claude、Gemini、opencode、Pi 的 hook 运行 <code>--silent</code>。
      </Note>

      <h2>交互式 vs 脚本安全</h2>
      <p>
        <code>login</code>、<code>setup</code>、交互式 <code>config</code> 用 Clack 提示。
        <code>hook</code>、<code>status</code>、<code>update</code>、<code>reset</code>、<code>url</code>
        保持<strong>脚本安全</strong>输出(纯 JSON 或静默)。
      </p>
    </Doc>
  );
}
