import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "RFCs — Agent Presence" }];
}

export default function Rfcs() {
  return (
    <Doc
      locale="en"
      title="RFCs"
      source={
        <>
          the <a href="https://github.com/PerfectPan/agent-presence">rfcs/</a>{" "}
          directory in the repository
        </>
      }
    >
      <p>
        The repository keeps substantial design proposals in <code>rfcs/</code>.
        These are the currently accepted / decided ones that affect users.
      </p>

      <h2>Token usage stats — <code>rfcs/token-usage-stats.md</code> (Accepted)</h2>
      <p>
        The presence pipeline tells you <em>which</em> agents are working, but not{" "}
        <em>how much</em> they have consumed. This RFC introduced{" "}
        <code>agent-presence usage</code> and the signature usage badges.
      </p>
      <p><strong>Design:</strong></p>
      <ul>
        <li>An after-the-fact transcript scan (the <a href="https://github.com/ryoppippi/ccusage">ccusage</a> approach), <strong>not</strong> hook payloads — lifecycle events do not carry token counts.</li>
        <li>Rolling windows were <strong>originally shipped, then replaced</strong> with calendar-day windows. A window of N days spans N local calendar days inclusive of today: <code>[startOfLocalDay(now) - (N-1)*24h, now)</code>.</li>
        <li>Per-source scan rules: Claude keep-final dedup (corrects ~3.8% under-count); Codex cumulative diff (avoids ~1.6x double-count); Pi trusts its own recorded cost. Gemini is intentionally absent — it does not persist per-message token usage locally.</li>
        <li>Pricing is a static, overridable USD-per-MTok table matched by model substring (longest match wins). Unknown models → <code>null</code> cost, exact tokens retained.</li>
        <li>Badges refresh only on <strong>session-boundary events</strong>; a single scan reads the whole window, so no cron/timer is needed.</li>
      </ul>
      <p>
        <strong>Rejected alternatives:</strong> reading token counts from hook
        payloads (events carry no usage); calendar-day <code>daily</code> grouping
        was reconsidered and <strong>adopted</strong> in 0.6.0; a live pricing feed
        was deferred (static table avoids a network dependency on the hot path).
      </p>

      <h2>Linux power/session watcher — <code>rfcs/linux-watcher.md</code> (Skipped)</h2>
      <p>
        macOS installs a LaunchAgent power watcher; the Linux equivalent was{" "}
        <strong>investigated and skipped</strong>. TTL pruning (3 minutes) already
        covers the primary failure mode (agent process exits without a finish hook).
      </p>
      <p><strong>Why skipped:</strong></p>
      <ol>
        <li>systemd user service behavior varies across distributions.</li>
        <li>The session D-Bus bus is unavailable in headless/SSH/container runtimes.</li>
        <li>Some distros disable the systemd user instance by default (or need <code>linger</code>).</li>
        <li>Even with logind signals, the watcher can't catch every case TTL doesn't.</li>
        <li>The test matrix would expand significantly with no clear safety benefit over TTL.</li>
      </ol>
      <p>
        <strong>When it would be reconsidered:</strong> systemd user instances and a
        lightweight D-Bus library are reliably present on target distros; a simple
        install/uninstall path exists; suspend/resume + lock/unlock testing covers
        at least two major distributions.
      </p>

      <h2>Default provider: magic-builder — <code>rfcs/default-provider-magic-builder.md</code> (Accepted)</h2>
      <p>
        Documented the decision to flip <code>DEFAULT_PROVIDER_ID</code> from{" "}
        <code>feishu-signature</code> to <code>magic-builder</code>. The push/write
        path is provider-agnostic and always writes to the l.garyyang slot; the
        default only affects which preview URL <code>setup</code> / <code>url</code>{" "}
        / <code>status --remote</code> target. Existing installs are unaffected
        (login persists an explicit <code>provider</code>).
      </p>
    </Doc>
  );
}
