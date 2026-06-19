import { Doc, Caution } from "~/components/Doc";

export function meta() {
  return [{ title: "Provider — Agent Presence" }];
}

export default function ZhProviders() {
  return (
    <Doc
      locale="zh"
      title="Provider"
      source={
        <>仓库 <a href="https://github.com/PerfectPan/agent-presence">README.md</a>(英文为单一真相来源)</>
      }
    >
      <p>
        默认 provider id 是 <strong><code>magic-builder</code></strong>。它是建立在
        <code>feishu-signature</code> slot 后端之上的预览前端。<code>feishu-signature</code>
        既是底层 slot 存储,也是<strong>直连预览的备选</strong>。无论用哪个,presence 值更新
        始终流向 <code>feishu-signature</code> slot —— provider 选择只改变飞书嵌入的是哪个预览 URL。
      </p>
      <pre><code>{`hooks ──> l.garyyang slot（始终）
              │
              ├── magic-builder FaaS（默认）每次预览拉取时读 /api/slot/info
              │        └──> https://magic.solutionsuite.cn/r?fid=<record_id>
              │
              └── feishu-signature 直连预览（--provider feishu-signature）
                       └──> https://l.garyyang.work/?t2=<base62(slot id)>`}</code></pre>

      <h2><code>magic-builder</code>(Magic-Builder FaaS 桥接,默认)</h2>
      <p>
        <code>magic-builder</code> 是默认 provider。它是<strong>预览前端,不是独立存储后端</strong>:
        它向 <code>magic.solutionsuite.cn</code> 发布一个小 FaaS,每次飞书拉取链接预览时,
        该 FaaS 在服务端运行,从 l.garyyang slot 读取当前值并作为预览标题返回。
      </p>
      <p>
        设为默认,是因为飞书可能<strong>不</strong>渲染 <code>l.garyyang.work</code> 直连页
        (它可能收紧个性签名预览的 iframe 白名单),而 <code>magic.solutionsuite.cn</code> 前端更可靠。
      </p>
      <p>
        <code>magic-builder</code> 依赖 <code>feishu-signature</code>:配置它仍需要 (1) l.garyyang 扫码登录
        (保存 slot 凭据),以及 (2) 一个单独的 Magic-Builder token 用于发布 FaaS。绕不开 l.garyyang 登录。
      </p>
      <pre><code>{`# 首次 setup 会跑 l.garyyang 扫码登录（保存 slot 凭据）并提示粘贴 Magic-Builder token。
# 想复用已有登录，可先运行 \`agent-presence login --provider feishu-signature\`，然后：
agent-presence setup --hook-command absolute`}</code></pre>

      <h3>获取 Magic-Builder token</h3>
      <p>
        在交互式终端且未配置 token 时,setup 会打印 token 获取说明并提示你粘贴,然后存入 OS keyring
        (macOS Keychain,Linux libsecret)。
      </p>
      <ol>
        <li>在飞书中打开妙笔(Magic-Builder)机器人:<a href="https://applink.larkoffice.com/T94fcr4NqQPz">applink.larkoffice.com/T94fcr4NqQPz</a></li>
        <li>发送消息 <code>dev</code>。</li>
        <li>从回复里复制 token。</li>
      </ol>
      <p>非交互环境可以不经提示直接提供 token:</p>
      <pre><code>{`export MAGIC_TOKEN=<token>          # 一次性，优先级最高
# 或 skill-pack 兼容的明文文件（本 CLI 只读取，不写入）：
echo <token> > ~/.magic-token && chmod 600 ~/.magic-token`}</code></pre>
      <p>
        <strong>token 解析顺序:</strong> <code>MAGIC_TOKEN</code> 环境变量 → OS keyring →
        <code>~/.magic-token</code> → <code>&lt;cwd&gt;/.magic-token</code>。
      </p>

      <h3>setup 发布的内容</h3>
      <p>
        <code>setup</code> 会构建一个嵌入了 slot id 和 bearer 的 CommonJS FaaS,POST 到
        <code>https://magic.solutionsuite.cn/api/faas</code>,并把返回的 <code>record_id</code> 存到
        <code>providers.magic-builder.faasId</code>。最终签名 URL 是:
      </p>
      <pre><code>{`https://magic.solutionsuite.cn/r?fid=<record_id>`}</code></pre>
      <p>
        重新运行 <code>setup --provider magic-builder</code> 会原地更新同一个 FaaS(幂等)。hook 仍然像以前一样
        写入 l.garyyang slot —— 每次飞书刷新预览时 FaaS 从 <code>/api/slot/info</code> 拉取(<strong>默认缓存 60s</strong>)。
      </p>

      <h3>查看实时预览</h3>
      <pre><code>{`agent-presence status --provider magic-builder --remote
# → .remote.faas.title, .remote.faas.expireStrategy`}</code></pre>

      <h3>覆盖项</h3>
      <pre><code>{`export MAGIC_TOKEN=...                                # 发布 token
export AGENT_PRESENCE_MAGIC_BUILDER_BASE_URL=...      # 覆盖 magic.solutionsuite.cn
export AGENT_PRESENCE_MAGIC_BUILDER_FAAS_ID=rec_...   # 固定已有的 FaaS record id
export AGENT_PRESENCE_MAGIC_BUILDER_FAAS_NAME=...     # 覆盖默认 agent_presence_preview
export AGENT_PRESENCE_MAGIC_BUILDER_FALLBACK_TITLE=...# slot 读取失败时渲染`}</code></pre>
      <Caution title="信任边界取舍">
        发布的 FaaS 嵌入了你的 l.garyyang slot bearer,以便在 <code>magic.solutionsuite.cn</code> 上读取 slot 值。
        这是"凭据永不离开本机"规则的<strong>唯一刻意例外</strong>。它需要显式操作者动作才会发生;
        嵌入的只是低敏感度的 slot bearer,<strong>绝不</strong>包含 magic-builder token(它留在 OS keyring)。
        轮换该 bearer 需重新运行 <code>setup --provider magic-builder</code> 重新发布。
      </Caution>

      <h2><code>feishu-signature</code>(slot 后端 + 直连预览备选)</h2>
      <p>
        <code>feishu-signature</code> 是存储 presence 值的底层 slot 后端;默认的 <code>magic-builder</code>
        就建立在它之上。直接选用它(通过 <code>--provider feishu-signature</code>)会跳过 Magic-Builder FaaS,
        直接从 <code>l.garyyang.work</code> 提供预览,<strong>无需</strong> Magic-Builder token。当飞书确实能
        渲染 <code>l.garyyang.work</code> 页时可以用它。
      </p>
      <p>它当前的 slot 后端是 <code>l.garyyang.work</code>:</p>
      <pre><code>{`GET  /api/slot/wechat/qrcode
GET  /api/slot/wechat/login-status?sceneId=...
POST /api/slot/update
GET  /api/slot/info`}</code></pre>
      <p>直连预览 URL 只包含编码后的 slot helper,不含凭据:</p>
      <pre><code>{`https://l.garyyang.work/?t2=<base62({{slot id="slot_xxx"}})>`}</code></pre>
      <p>配置 provider 专属链接预览字段:</p>
      <pre><code>{`agent-presence config provider feishu-signature \\
  --base-url "https://l.garyyang.work" \\
  --preview-base-url "https://l.garyyang.work/" \\
  --image-key "img_xxx" \\
  --target-url "https://example.com"`}</code></pre>
      <p>凭据默认存在 macOS Keychain 或 Linux libsecret。环境变量覆盖:</p>
      <pre><code>{`export AGENT_PRESENCE_TOKEN=...
export AGENT_PRESENCE_SLOT_ID=slot_xxx
export AGENT_PRESENCE_FEISHU_SIGNATURE_BASE_URL="https://l.garyyang.work"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_BASE_URL="https://l.garyyang.work/"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_IMAGE_KEY="img_xxx"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_TARGET_URL="https://example.com"`}</code></pre>
      <p>token 和 slot 凭据不会写入 git、签名 URL 或日志。</p>
    </Doc>
  );
}
