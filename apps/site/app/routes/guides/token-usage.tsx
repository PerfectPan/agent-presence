import { Doc, Note } from "~/components/Doc";
import { AsciinemaPlayer } from "~/components/AsciinemaPlayer";

export function meta() {
  return [{ title: "Token usage — Agent Presence" }];
}

export default function TokenUsage() {
  return (
    <Doc
      locale="en"
      title="Token usage"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>{" "}
          and <a href="https://github.com/PerfectPan/agent-presence">rfcs/token-usage-stats.md</a>
        </>
      }
    >
      <p>
        <code>agent-presence usage</code> reports token consumption over{" "}
        <strong>calendar-day windows</strong>, in the spirit of{" "}
        <a href="https://github.com/ryoppippi/ccusage">ccusage</a>: it does{" "}
        <strong>not</strong> hook the agents, it scans their local transcripts after
        the fact.
      </p>
      <pre><code>{`agent-presence usage            # today and the last 7 days side by side
agent-presence usage --days 7   # a single calendar-day window
agent-presence usage --json     # structured output for scripts`}</code></pre>

      <h2>Sources and how cost is derived</h2>
      <table>
        <thead>
          <tr><th>Source</th><th>Transcript</th><th>Cost</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>claude</code></td>
            <td><code>~/.claude/projects/**/*.jsonl</code> (honours <code>CLAUDE_CONFIG_DIR</code>)</td>
            <td>priced from the table; de-duplicated by <code>message.id</code> + <code>requestId</code> keeping the final (largest) occurrence; <code>&lt;synthetic&gt;</code> turns excluded — verified to match ccusage</td>
          </tr>
          <tr>
            <td><code>codex</code></td>
            <td><code>~/.codex/sessions/</code> and <code>~/.codex/archived_sessions/</code></td>
            <td>priced from the table; diffs the cumulative <code>total_token_usage</code> per session (summing per-event <code>last_token_usage</code> double-counts ~1.6x)</td>
          </tr>
          <tr>
            <td><code>pi</code></td>
            <td><code>~/.pi/agent/sessions/**/*.jsonl</code></td>
            <td>uses the cost Pi already records in the transcript</td>
          </tr>
          <tr>
            <td><code>gemini</code></td>
            <td>—</td>
            <td><strong>not tracked</strong>: Gemini does not persist per-message token usage locally</td>
          </tr>
        </tbody>
      </table>
      <Note>
        Token statistics cover <strong>Claude, Codex, and Pi only</strong>. Gemini
        and opencode are not scanned for usage. All five sources still contribute{" "}
        <strong>presence</strong>.
      </Note>

      <h2>Calendar-day windows (not rolling)</h2>
      <p>
        A window of N days spans N local calendar days inclusive of today —{" "}
        <code>[startOfLocalDay(now) - (N-1)*24h, now)</code>. So <code>今日</code>{" "}
        (1 day) counts from <strong>local midnight</strong> and{" "}
        <strong>resets at 00:00</strong>, rather than sliding as a rolling 24h
        window would (which would make the figure drop mid-day as old activity
        ages out).
      </p>
      <p>
        Cost shows <code>n/a</code> when a model has no entry in the pricing table;
        token counts are always exact.
      </p>

      <h2>Pricing overrides</h2>
      <p>
        The default pricing is best-effort and will drift; override it per model
        (USD per million tokens) without a code change:
      </p>
      <pre><code>{`// ~/.agent-presence/config.json
{
  "usage": {
    "showInSignature": false,        // append "今日 …" to the signature title
    "signatureWindowDays": 1,        // window used by the signature badge
    "pricing": { "opus": { "input": 15, "output": 75 } }
  }
}`}</code></pre>

      <h2>Usage in the signature</h2>
      <p>
        Usage in the signature is driven by render-template variables, so you
        compose your own label and choose which windows to show:
      </p>
      <table>
        <thead><tr><th>Variable</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>{"{usage}"}</code></td><td>badge for the default window (<code>usage.signatureWindowDays</code>, default 1)</td></tr>
          <tr><td><code>{"{usage_1d}"}</code></td><td>1-day calendar badge, e.g. <code>2.1M · $4.50</code></td></tr>
          <tr><td><code>{"{usage_7d}"}</code></td><td>7-day calendar badge — any <code>{"{usage_Nd}"}</code> works</td></tr>
        </tbody>
      </table>
      <pre><code>{`agent-presence config render --many "{total} 个 AI 牛马 | {details} | 今日 {usage_1d} · 近7天 {usage_7d}"`}</code></pre>
      <p>
        Referencing any <code>{"{usage*}"}</code> token enables scanning for the
        windows it names. For a zero-config option, set{" "}
        <code>usage.showInSignature: true</code> (or{" "}
        <code>AGENT_PRESENCE_USAGE_IN_SIGNATURE=1</code>) to auto-append the
        default window (labelled <code>今日</code> for 1 day, <code>近N天</code>{" "}
        otherwise) without editing templates.
      </p>

      <h2>Refresh model (no cron)</h2>
      <p>
        Badges are refreshed by a full transcript rescan only on{" "}
        <strong>session-boundary events</strong> (a session starting or finishing);
        high-frequency tool events reuse the cached badges and never trigger a
        scan. Because each scan reads the entire window, any single refresh yields
        the complete, correct total — so boundary-only refresh stays accurate{" "}
        <strong>without a background timer or cron</strong>.
      </p>
      <p>
        The trade-off: while a session is mid-flight the badge reflects the total
        as of its last boundary, not the live in-progress count.
      </p>

      <h2>Stale-badge guard</h2>
      <p>
        Because nothing runs while the machine is idle or off, a cached badge can
        outlive its window (e.g. yesterday's <code>今日</code> total still showing
        the next morning). To avoid displaying a number that has quietly gone
        wrong, a badge whose whole window has rolled over since it was computed —
        one midnight for <code>今日</code>, seven days for <code>近7天</code> —
        renders as <code>—</code> until the next session-boundary refresh
        recomputes it. The label you wrote in the template stays; only the value
        collapses to the placeholder.
      </p>

      <h2>Terminal replay</h2>
      <p>
        The cast below replays a read-only <code>agent-presence usage</code>{" "}
        invocation with <strong>sanitized, illustrative</strong> token/cost
        figures.
      </p>
      <AsciinemaPlayer src="/casts/usage.cast" title="agent-presence usage replay" />
    </Doc>
  );
}
