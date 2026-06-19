import { Link } from "react-router";
import { LandingHero } from "~/components/LandingHero";

export function meta() {
  return [
    { title: "Agent Presence — sync coding-agent presence to Feishu signatures" },
    {
      name: "description",
      content:
        "@rivus/agent-presence syncs local coding-agent presence to Feishu signature link previews. Hook-driven, zero cron, macOS & Linux.",
    },
  ];
}

export default function Home() {
  return (
    <div className="min-h-screen">
      <LandingHero locale="en" />
      <section className="mx-auto w-full max-w-[var(--maxw,78rem)] px-4 pb-16 sm:px-6">
        <div className="space-y-4 leading-7">
          <h2 className="text-xl font-semibold">What it is</h2>
          <p>
            <code>@rivus/agent-presence</code> is intentionally named around{" "}
            <strong>presence</strong>, not Feishu. It turns local coding-agent
            lifecycle events into a Feishu signature link-preview value,
            modeling active work from agent hooks rather than process scans.
          </p>
          <pre>
            <code>{`Codex / Claude Code / Gemini CLI / opencode / Pi Coding Agent
  -> a live count of agents actually working
  -> rendered into your Feishu signature link preview`}</code>
          </pre>
          <p className="text-sm text-[var(--muted-foreground)]">
            For the full runtime pipeline and trust boundaries, see{" "}
            <Link to="/project/architecture" className="underline">
              Architecture
            </Link>
            .
          </p>
          <h2 className="text-xl font-semibold">Get started in 30 seconds</h2>
          <pre>
            <code>{`pnpm add -g @rivus/agent-presence
agent-presence setup
agent-presence url`}</code>
          </pre>
          <p>
            The first <code>setup</code> walks you through login and publishes
            your signature preview. Then paste the URL into your Feishu profile
            signature as a custom link preview.
          </p>
          <p>
            ➡️ Continue to the{" "}
            <Link to="/guides/quickstart" className="underline">
              Quickstart
            </Link>
            , or read about{" "}
            <Link to="/guides/providers" className="underline">
              providers
            </Link>
            ,{" "}
            <Link to="/guides/token-usage" className="underline">
              token usage
            </Link>
            , and{" "}
            <Link to="/guides/presence-semantics" className="underline">
              presence semantics
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
