import { Link } from "react-router";
import { LandingHero } from "~/components/LandingHero";

export function meta() {
  return [
    { title: "Agent Presence — 把编码智能体的 presence 同步到飞书签名" },
    {
      name: "description",
      content:
        "@rivus/agent-presence 把本机编码智能体的 presence 同步到飞书签名链接预览。基于 hook 驱动,零 cron,支持 macOS 与 Linux。",
    },
  ];
}

export default function ZhHome() {
  return (
    <div className="min-h-screen">
      <LandingHero locale="zh" />
      <section className="mx-auto w-full max-w-[var(--maxw,78rem)] px-4 pb-16 sm:px-6">
        <div className="space-y-4 leading-7">
          <h2 className="text-xl font-semibold">这是什么</h2>
          <p>
            <code>@rivus/agent-presence</code> 的核心是 <strong>presence</strong>,
           而不是飞书专用逻辑。它把本机编码智能体的生命周期事件转成飞书签名
            链接预览值,基于智能体 hook 而非进程扫描来建模"正在干活"。
          </p>
          <pre>
            <code>{`Codex / Claude Code / Gemini CLI / opencode / Pi Coding Agent hooks
-> 本地 presence 状态
-> 防抖渲染
-> l.garyyang slot 存储（始终）
-> magic.solutionsuite.cn 上的 magic-builder FaaS 预览（默认）
   （备选：通过 --provider feishu-signature 使用 l.garyyang.work 直连预览）`}</code>
          </pre>
          <h2 className="text-xl font-semibold">30 秒上手</h2>
          <pre>
            <code>{`pnpm add -g @rivus/agent-presence
agent-presence setup
agent-presence url`}</code>
          </pre>
          <p>
            首次 <code>setup</code> 会跑 l.garyyang 扫码登录,并提示你粘贴
            Magic-Builder token 以发布预览 FaaS。然后把输出的 URL 粘贴到飞书
            个人资料签名的自定义链接预览里。
          </p>
          <p>
            ➡️ 继续看 <Link to="/zh/guides/quickstart" className="underline">快速上手</Link>,
           或了解 <Link to="/zh/guides/providers" className="underline">Provider</Link>、
            <Link to="/zh/guides/token-usage" className="underline">Token 用量</Link>、
            <Link to="/zh/guides/presence-semantics" className="underline">Presence 语义</Link>。
          </p>
          <p className="text-sm text-[var(--muted-foreground)]">
            <em>注:英文 README 是单一真相来源,中文为镜像翻译,如有一致性差异以英文为准。</em>
          </p>
        </div>
      </section>
    </div>
  );
}
