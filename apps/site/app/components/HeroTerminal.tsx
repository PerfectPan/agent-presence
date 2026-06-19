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

export function HeroTerminal() {
  const [stepIdx, setStepIdx] = useState(0);
  const [lineIdx, setLineIdx] = useState(0);
  const [chars, setChars] = useState(0);
  const [badge, setBadge] = useState<string>(FLOW[0].badge ?? "");
  const [flash, setFlash] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reduced motion: render the final state statically, no animation loop.
  useEffect(() => {
    if (!reduced) return;
    setStepIdx(FLOW.length - 1);
    setLineIdx(FLOW[FLOW.length - 1].lines.length);
    setChars(0);
    setBadge(FLOW[FLOW.length - 1].badge ?? "");
  }, [reduced]);

  // Typewriter loop — only when visible & not reduced.
  useEffect(() => {
    if (reduced) return;
    const el = sectionRef.current;
    if (!el) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !startedRef.current) {
            startedRef.current = true;
            tick();
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  function tick() {
    setChars((c) => {
      const step = FLOW[stepIdx];
      if (!step) return c;
      const currentLine = step.lines[lineIdx];
      if (!currentLine) {
        // advance line
        if (lineIdx + 1 >= step.lines.length) {
          // step done -> update badge, advance step
          if (step.badge) {
            setBadge(step.badge);
            setFlash(true);
            window.setTimeout(() => setFlash(false), 500);
          }
          if (stepIdx + 1 >= FLOW.length) {
            // loop
            window.setTimeout(() => {
              setStepIdx(0);
              setLineIdx(0);
              setChars(0);
              setBadge(FLOW[0].badge ?? "");
              tick();
            }, 4200);
            return 0;
          }
          setStepIdx((s) => s + 1);
          setLineIdx(0);
          window.setTimeout(tick, 220);
          return 0;
        }
        setLineIdx((l) => l + 1);
        window.setTimeout(tick, 220);
        return 0;
      }
      if (c + 1 >= currentLine.length) {
        window.setTimeout(tick, 180);
        return currentLine.length;
      }
      window.setTimeout(tick, 26);
      return c + 1;
    });
  }

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
      className="relative overflow-hidden rounded-[var(--radius)] border border-[var(--color-term-border)] bg-[var(--color-term-bg)] font-mono shadow-[0_0_28px_rgba(77,123,255,0.22)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-term-border)] bg-[var(--color-term-panel)] px-3.5 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-auto text-xs text-[var(--color-term-text-dim)]">
          agent-presence — zsh
        </span>
      </div>
      <pre className="m-0 min-h-[13rem] overflow-x-auto whitespace-pre-wrap break-words px-4 pb-14 pt-4 text-[0.82rem] leading-[1.55] text-[var(--color-term-text)]">
        <code>
          {visible.map((line, i) => (
            <div key={i} className={lineClass(line)}>
              {line}
            </div>
          ))}
          {!reduced && !typingComplete ? <span className="ap-cursor" /> : null}
        </code>
      </pre>

      <div className="absolute inset-x-4 bottom-4 flex items-center gap-3 rounded-[0.5rem] border border-[color-mix(in_srgb,var(--color-neon-blue)_40%,transparent)] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-neon-blue-soft)_22%,transparent),color-mix(in_srgb,var(--color-neon-green-soft)_18%,transparent))] px-3.5 py-2.5 backdrop-blur-sm">
        <span className="whitespace-nowrap text-[0.68rem] uppercase tracking-wide text-[var(--color-term-text-dim)]">
          Feishu signature · live
        </span>
        <span
          className={`flex-1 text-[0.85rem] text-[var(--color-term-text)] ${flash ? "ap-flash" : ""}`}
        >
          {badge}
        </span>
        <span className="relative h-2 w-2">
          <span className="absolute inset-0 rounded-full bg-[var(--color-neon-green)]" />
          <span className="ap-ping absolute inset-0 rounded-full bg-[var(--color-neon-green)]" />
        </span>
      </div>
    </section>
  );
}
