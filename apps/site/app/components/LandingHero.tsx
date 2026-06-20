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
    <div className="mx-auto w-full max-w-[var(--maxw,78rem)] px-4 pb-16 sm:px-6">
      {/* Hero */}
      <section className="grid grid-cols-1 items-center gap-10 py-12 lg:grid-cols-[1.1fr_1fr] lg:py-20">
        <div>
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--muted)] px-3 py-1 font-mono text-[0.7rem] text-[var(--muted-foreground)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-neon-green)]" />
            @rivus/agent-presence · v0.6.0
          </span>
          <h1 className="font-[var(--font-display)] text-[2.6rem] font-bold leading-[1.04] tracking-tight text-[var(--foreground)] sm:text-6xl">
            {t("Your ", "你的 ")}
            <span className="bg-gradient-to-r from-[#2563eb] to-[#7c3aed] bg-clip-text text-transparent">
              {t("coding agents", "编码智能体")}
            </span>
            <br />
            <span className="text-[var(--foreground)]">
              {t("live in your Feishu signature.", "实时出现在飞书签名。")}
            </span>
          </h1>
          <p className="mt-6 max-w-[44ch] text-[1.05rem] leading-relaxed text-[var(--muted-foreground)]">
            {t(
              "Sync local coding-agent presence to Feishu signature link previews. Hook-driven — it counts agents that are actually working, never scans processes.",
              "把本机编码智能体的 presence 同步到飞书签名链接预览。基于 hook 驱动 —— 只统计正在干活的智能体,绝不扫描进程。",
            )}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={copy}
              className="group inline-flex items-center gap-2.5 rounded-[0.6rem] bg-[var(--primary)] px-4 py-2.5 font-mono text-sm text-[var(--primary-foreground)] shadow-[0_8px_24px_-8px_color-mix(in_srgb,var(--primary)_60%,transparent)] transition-all hover:-translate-y-0.5 hover:shadow-[0_12px_30px_-8px_color-mix(in_srgb,var(--primary)_70%,transparent)]"
            >
              <code>{INSTALL_CMD}</code>
              <span className="text-xs uppercase tracking-wide opacity-80 transition-opacity group-hover:opacity-100">
                {copied ? "copied!" : "copy"}
              </span>
            </button>
            <Link
              to={quickstart}
              className="rounded-[0.6rem] border border-[var(--border)] bg-[var(--card)] px-4 py-2.5 text-sm text-[var(--foreground)] transition-all hover:-translate-y-0.5 hover:border-[var(--primary)]"
            >
              {t("Quickstart →", "快速上手 →")}
            </Link>
          </div>
        </div>
        {/* Terminal card: the product's own "screen". Clean border + soft
            elevation instead of a glow halo (which read as muddy on light). */}
        <div className="relative">
          <div className="relative rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[0_12px_40px_-12px_rgba(15,23,42,0.18)]">
            <HeroTerminal />
          </div>
        </div>
      </section>

      {/* Pipeline — user-facing, no internal storage details. */}
      <section className="my-10 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-6">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[0.82rem]">
          <PipeNode>{t("agent starts work", "智能体开始工作")}</PipeNode>
          <PipeArrow />
          <PipeNode>{t("hook fires", "hook 触发")}</PipeNode>
          <PipeArrow />
          <PipeNode accent="blue">{t("live badge updates", "实时 badge 更新")}</PipeNode>
          <PipeArrow />
          <PipeNode accent="green">{t("Feishu signature preview", "飞书签名预览")}</PipeNode>
        </div>
        <p className="mt-4 text-sm text-[var(--muted-foreground)]">
          {t(
            "Hook-driven — it counts agents that are actually working, never scans processes. No cron, no background timer.",
            "基于 hook 驱动 —— 只统计正在干活的智能体,绝不扫描进程。没有 cron,没有后台定时器。",
          )}
        </p>
      </section>

      {/* Features */}
      <section className="my-10">
        <h2 className="mb-5 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--muted-foreground)]">
          {t("Features", "核心特性")}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <article
              key={f.title.en}
              className="group rounded-[0.75rem] border border-[var(--border)] bg-[var(--card)] p-5 transition-all hover:-translate-y-1 hover:border-[color-mix(in_srgb,var(--primary)_50%,var(--border))] hover:shadow-[0_12px_32px_-12px_rgba(37,99,235,0.25)]"
            >
              <div
                className="mb-3 flex h-10 w-10 items-center justify-center rounded-[0.6rem] bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-xl transition-transform group-hover:scale-110"
                aria-hidden="true"
              >
                {f.icon}
              </div>
              <h3 className="mb-1.5 text-[1.02rem] font-semibold text-[var(--foreground)]">
                {t(f.title.en, f.title.zh)}
              </h3>
              <p className="text-sm leading-[1.55] text-[var(--muted-foreground)]">
                {t(f.body.en, f.body.zh)}
              </p>
            </article>
          ))}
        </div>
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
