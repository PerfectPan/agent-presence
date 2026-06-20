import { useEffect, useRef, useState } from "react";

/**
 * HeroTerminal — a self-contained animated "terminal" that types out a real
 * agent-presence usage flow and mocks the Feishu signature badge changing live.
 *
 * All on-screen text is drawn from real README output (sanitized placeholders):
 *   - slot id: slot_xxx
 *   - faas id: <faasId>
 *   - usage badge: 2.1M · $4.50 (the README's documented example format)
 * No real credentials ever appear.
 *
 * Accessibility: honors prefers-reduced-motion. When set, the typewriter is
 * skipped and the final state is shown statically (no animation).
 */

interface Step {
  /** Lines to type. `$ `-prefixed render as commands; `✔`/`▸` as success. */
  lines: string[];
  /** Badge value to show in the signature card after these lines. */
  badge?: string;
}

const FLOW: Step[] = [
  {
    lines: ["$ pnpm add -g @rivus/agent-presence", "✔ @rivus/agent-presence installed"],
    badge: "AI 牛马暂未开工",
  },
  {
    lines: [
      "$ agent-presence setup",
      "▸ l.garyyang QR login … ok",
      "▸ publish magic-builder FaaS … ok",
    ],
    badge: "AI 牛马暂未开工",
  },
  {
    lines: ["$ agent-presence url", "https://magic.solutionsuite.cn/r?fid=<faasId>"],
    badge: "AI 牛马暂未开工",
  },
  { lines: ["# codex session started …"], badge: "1 个 AI 牛马正在搬砖 | codex 1" },
  {
    lines: ["# claude code + gemini started …"],
    badge: "3 个 AI 牛马正在搬砖 | codex 1 · claude 1 · gemini 1",
  },
  {
    lines: [
      "$ agent-presence usage",
      "today    2.1M · $4.50",
      "last 7d  18.7M · $41.20",
    ],
    badge: "3 个 AI 牛马 · 今日 2.1M · $4.50",
  },
];

function lineClass(line: string): string {
  if (line.startsWith("$ ")) return "text-[var(--color-term-prompt)]";
  if (line.startsWith("✔") || line.startsWith("▸"))
    return "text-[var(--color-term-prompt)]";
  return "text-[var(--color-term-text-dim)]";
}

/**
 * SSR-safe reduced-motion check. Guards against `window`/`matchMedia` being
 * undefined during prerender; defaults to false (animate) on the server, then
 * the effect re-evaluates on the client.
 */
function getReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function HeroTerminal() {
  // Animation state is kept in a single ref and advanced by one setTimeout
  // chain. This avoids stale closures over React state (the previous version
  // read stepIdx/lineIdx from a closure that never updated, so the hero stalled
  // on the first line). React state mirrors only what the UI needs to render.
  const [stepIdx, setStepIdx] = useState(0);
  const [lineIdx, setLineIdx] = useState(0);
  const [chars, setChars] = useState(0);
  const [badge, setBadge] = useState<string>(FLOW[0].badge ?? "");
  const [flash, setFlash] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reduced = getReducedMotion();

  // Reduced motion: render the final state statically, no animation loop.
  useEffect(() => {
    if (!reduced) return;
    setStepIdx(FLOW.length - 1);
    setLineIdx(FLOW[FLOW.length - 1].lines.length);
    setBadge(FLOW[FLOW.length - 1].badge ?? "");
  }, [reduced]);

  // Typewriter loop — only when visible & not reduced. Uses a local mutable
  // cursor so the scheduler always reads fresh values.
  useEffect(() => {
    if (reduced) return;
    const el = sectionRef.current;
    if (!el) return;

    let disposed = false;
    const cursor = { step: 0, line: 0, chars: 0 };

    function schedule(delay: number) {
      if (disposed) return;
      timerRef.current = setTimeout(advance, delay);
    }

    function setBadgeAndFlash(value: string) {
      setBadge(value);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 500);
    }

    function advance() {
      if (disposed) return;
      const step = FLOW[cursor.step];
      if (!step) return;
      const currentLine = step.lines[cursor.line];

      if (currentLine === undefined) {
        // finished all lines of this step → stamp badge, advance step
        if (step.badge) setBadgeAndFlash(step.badge);
        if (cursor.step + 1 >= FLOW.length) {
          // loop after a pause
          schedule(4200);
          cursor.step = 0;
          cursor.line = 0;
          cursor.chars = 0;
          setStepIdx(0);
          setLineIdx(0);
          setChars(0);
          setBadge(FLOW[0].badge ?? "");
          return;
        }
        cursor.step += 1;
        cursor.line = 0;
        cursor.chars = 0;
        setStepIdx(cursor.step);
        setLineIdx(0);
        setChars(0);
        schedule(220);
        return;
      }

      // still typing the current line
      if (cursor.chars >= currentLine.length) {
        // line complete → move to next line
        cursor.line += 1;
        cursor.chars = 0;
        setLineIdx(cursor.line);
        setChars(0);
        schedule(220);
        return;
      }
      cursor.chars += 1;
      setChars(cursor.chars);
      schedule(26);
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            // start (or resume) the chain once when it first enters the viewport
            if (timerRef.current === null) schedule(300);
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);

    return () => {
      disposed = true;
      io.disconnect();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [reduced]);

  // Keep the latest typed line in view: scroll the terminal to the bottom
  // whenever the visible content changes (like a real tailing terminal).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stepIdx, lineIdx, chars]);

  // Build the visible lines from current state.
  const done = FLOW.slice(0, stepIdx).flatMap((s) => s.lines);
  const current = FLOW[stepIdx]?.lines ?? [];
  const partial = current.slice(0, lineIdx);
  const typing = current[lineIdx]?.slice(0, chars) ?? "";
  const visible = [...done, ...partial, typing].filter(Boolean);
  const typingComplete = chars >= (current[lineIdx]?.length ?? 0);

  return (
    <section
      ref={sectionRef}
      aria-label="Agent Presence usage replay"
      className="flex flex-col gap-3 font-mono"
    >
      {/* Terminal body: fixed-height, top-aligned so lines grow downward without
          jumping. The badge lives in normal flow below, so it never overlaps.
          Outer border/shadow come from the LandingHero card wrapper. */}
      <div className="relative overflow-hidden rounded-t-[var(--radius)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-term-border)] bg-[var(--color-term-panel)] px-3.5 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-auto text-xs text-[var(--color-term-text-dim)]">
            agent-presence — zsh
          </span>
        </div>
        <div
          ref={scrollRef}
          className="ap-scanlines relative h-[14.5rem] overflow-x-auto overflow-y-auto bg-[var(--color-term-bg)]"
        >
          {/* Top-aligned, fixed-height, auto-scrolls to follow new lines (see
              the scrollTop effect above). The box size never changes, so adding
              lines never jumps the rest of the page. */}
          <pre className="m-0 px-4 py-3.5 text-[0.82rem] leading-[1.6] text-[var(--color-term-text)]">
            <code>
              {visible.map((line, i) => (
                <div key={i} className={lineClass(line)}>
                  {line}
                </div>
              ))}
              {!reduced && !typingComplete ? <span className="ap-cursor" /> : null}
            </code>
          </pre>
        </div>
      </div>

      {/* Live signature badge — in normal document flow, no overlap, no jump. */}
      <div className="flex items-center gap-3 rounded-[0.5rem] border border-[color-mix(in_srgb,var(--color-neon-blue)_35%,transparent)] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-neon-blue-soft)_18%,transparent),color-mix(in_srgb,var(--color-neon-green-soft)_14%,transparent))] px-3.5 py-2.5 backdrop-blur-sm">
        <span className="whitespace-nowrap text-[0.68rem] uppercase tracking-wide text-[var(--color-term-text-dim)]">
          Feishu signature · live
        </span>
        <span
          className={`flex-1 text-[0.85rem] text-[var(--color-term-text)] ${flash ? "ap-flash" : ""}`}
        >
          {badge}
        </span>
        <span className="relative h-2 w-2 shrink-0">
          <span className="absolute inset-0 rounded-full bg-[var(--color-neon-green)]" />
          <span className="ap-ping absolute inset-0 rounded-full bg-[var(--color-neon-green)]" />
        </span>
      </div>
    </section>
  );
}
