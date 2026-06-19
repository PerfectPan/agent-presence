import { Link } from "react-router";
import { useState } from "react";
import { HeroTerminal } from "./HeroTerminal";
import type { Locale } from "~/lib/nav";
import { hrefFor } from "~/lib/nav";

const FEATURES: { icon: string; title: { en: string; zh: string }; body: { en: string; zh: string } }[] = [
  {
    icon: "🤖",
    title: { en: "5 agents, one presence", zh: "5 个智能体,一个 presence" },
    body: {
      en: "Codex, Claude Code, Gemini CLI, opencode, and Pi Coding Agent hooks feed a single live count.",
      zh: "Codex、Claude Code、Gemini CLI、opencode、Pi 的 hook 汇聚成一个实时计数。",
    },
  },
  {
    icon: "🔗",
    title: { en: "Feishu signature preview", zh: "飞书签名预览" },
    body: {
      en: "The count renders into a Feishu profile signature link preview via the magic-builder FaaS front-end.",
      zh: "计数通过 magic-builder FaaS 前端渲染到飞书个人签名的链接预览里。",
    },
  },
  {
    icon: "💸",
    title: { en: "Token usage with cost", zh: "带成本的 Token 用量" },
    body: {
      en: "Calendar-day token consumption (ccusage-style) for Claude, Codex, and Pi, with per-model pricing overrides.",
      zh: "按自然日统计 token 消耗(ccusage 风格),覆盖 Claude、Codex、Pi,可按模型覆盖价格。",
    },
  },
  {
    icon: "🚫",
    title: { en: "Zero cron", zh: "零 cron" },
    body: {
      en: "No background timer. Badges refresh on session-boundary events; a stale-badge guard renders — when the window rolls over.",
      zh: "没有后台定时器。badge 只在会话边界刷新;窗口翻页时陈旧 badge 会渲染为 —。",
    },
  },
  {
    icon: "🐧",
    title: { en: "macOS & Linux", zh: "macOS 与 Linux" },
    body: {
      en: "Keychain + LaunchAgent on macOS; libsecret + TTL pruning on Linux. Windows is not supported yet.",
      zh: "macOS 用 Keychain + LaunchAgent;Linux 用 libsecret + TTL 清理。Windows 暂不支持。",
    },
  },
];

const INSTALL_CMD = "pnpm add -g @rivus/agent-presence";

export function LandingHero({ locale }: { locale: Locale }) {
  const [copied, setCopied] = useState(false);
  const t = (en: string, zh: string) => (locale === "zh" ? zh : en);
  const quickstart = hrefFor(locale, "guides/quickstart");

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable (non-secure context) */
    }
  }

  return (
    <div className="mx-auto w-full max-w-[var(--maxw,78rem)] px-4 sm:px-6">
      {/* Hero */}
      <section className="ap-grid-bg grid grid-cols-1 items-center gap-10 py-8 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <p className="mb-3 font-mono text-xs text-[var(--color-neon-green)]">
            @rivus/agent-presence · v0.6.0
          </p>
          <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
            {t("Your ", "你的 ")}
            <span className="bg-gradient-to-r from-[var(--color-neon-green)] to-[var(--color-neon-blue)] bg-clip-text text-transparent">
              {t("coding agents", "编码智能体")}
            </span>
            {t(
              ", live in your Feishu signature.",
              ",实时出现在你的飞书签名里。",
            )}
          </h1>
          <p className="mt-4 max-w-[38ch] text-[var(--muted-foreground)]">
            {t(
              "Sync local coding-agent presence to Feishu signature link previews. Hook-driven — it counts agents that are actually working, never scans processes.",
              "把本机编码智能体的 presence 同步到飞书签名链接预览。基于 hook 驱动 —— 只统计正在干活的智能体,绝不扫描进程。",
            )}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-2.5 rounded-[0.5rem] border border-[var(--color-neon-green-soft)] bg-[color-mix(in_srgb,var(--color-neon-green-soft)_16%,transparent)] px-3.5 py-2 font-mono text-sm text-[var(--color-term-text)] shadow-[0_0_24px_rgba(47,203,107,0.18)] transition-transform hover:-translate-y-px"
            >
              <code>{INSTALL_CMD}</code>
              <span className="text-xs uppercase tracking-wide text-[var(--color-term-text-dim)]">
                {copied ? "copied!" : "copy"}
              </span>
            </button>
            <Link
              to={quickstart}
              className="rounded-[0.5rem] border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--color-neon-blue)]"
            >
              {t("Quickstart →", "快速上手 →")}
            </Link>
          </div>
        </div>
        <HeroTerminal />
      </section>

      {/* Pipeline — user-facing, no internal storage details. */}
      <section className="ap-grid-bg my-8 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-5">
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[0.82rem]">
          <PipeNode>{t("agent starts work", "智能体开始工作")}</PipeNode>
          <PipeArrow />
          <PipeNode>{t("hook fires", "hook 触发")}</PipeNode>
          <PipeArrow />
          <PipeNode accent="blue">{t("live badge updates", "实时 badge 更新")}</PipeNode>
          <PipeArrow />
          <PipeNode accent="green">{t("Feishu signature preview", "飞书签名预览")}</PipeNode>
        </div>
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">
          {t(
            "Hook-driven — it counts agents that are actually working, never scans processes. No cron, no background timer.",
            "基于 hook 驱动 —— 只统计正在干活的智能体,绝不扫描进程。没有 cron,没有后台定时器。",
          )}
        </p>
      </section>

      {/* Features */}
      <section className="my-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <article
            key={f.title.en}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--color-term-bg2)] p-5 transition-colors hover:border-[var(--color-neon-blue)]"
          >
            <div className="mb-2 text-2xl" aria-hidden="true">
              {f.icon}
            </div>
            <h3 className="mb-1 text-base font-semibold">{t(f.title.en, f.title.zh)}</h3>
            <p className="text-sm leading-[1.5] text-[var(--muted-foreground)]">
              {t(f.body.en, f.body.zh)}
            </p>
          </article>
        ))}
      </section>
    </div>
  );
}

function PipeNode({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent?: "blue" | "green";
}) {
  const border =
    accent === "blue"
      ? "border-[var(--color-neon-blue-soft)]"
      : accent === "green"
        ? "border-[var(--color-neon-green-soft)]"
        : "border-[var(--border)]";
  return (
    <span
      className={`rounded-[0.5rem] border ${border} bg-[var(--color-term-panel)] px-2.5 py-1.5 text-[var(--color-term-text)]`}
    >
      {children}
    </span>
  );
}

function PipeArrow() {
  return <span className="text-[var(--color-term-text-dim)]">→</span>;
}
