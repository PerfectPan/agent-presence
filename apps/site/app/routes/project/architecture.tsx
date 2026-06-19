import { Link } from "react-router";
import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "Architecture — Agent Presence" }];
}

export default function Architecture() {
  return (
    <Doc
      locale="en"
      title="Architecture"
      source={
        <>
          <a href="https://github.com/PerfectPan/agent-presence">docs/architecture.md</a>{" "}
          in the repository (authoritative)
        </>
      }
    >
      <p>
        <code>@rivus/agent-presence</code> turns local coding-agent lifecycle
        events into a Feishu signature link-preview value. The important boundary
        is that it models active work from <strong>agent hooks, not from process
        scans</strong>.
      </p>

      <h2>The pipeline</h2>
      <pre><code>{`Codex / Claude Code / Gemini CLI / opencode / Pi Coding Agent lifecycle hooks
-> CLI hook normalizer
-> locked JSON state
-> TTL pruning
-> debounce renderer
-> slot provider update  (always written to the l.garyyang slot)
-> Feishu signature link preview`}</code></pre>
      <p>Two paths split cleanly:</p>
      <ul>
        <li>
          <strong>Interactive path</strong>: <code>login</code> / <code>setup</code>{" "}
          / <code>config</code> / <code>status</code> / <code>url</code> /{" "}
          <code>update</code> / <code>reset</code> — may use Clack prompts.
        </li>
        <li>
          <strong>Hook path</strong>: agent lifecycle event → silent CLI → local
          state → optional slot sync. Must be <strong>fast, bounded,
          non-interactive, and safe</strong> to call from another agent runtime.
        </li>
      </ul>

      <h2>Providers</h2>
      <p>
        The default provider id is <code>magic-builder</code>, a preview front-end
        built on the <code>feishu-signature</code> slot backend:
      </p>
      <pre><code>{`hooks -> l.garyyang slot (unchanged write path)
                 ^
                 | GET /api/slot/info  (fetched on each preview refresh)
magic-builder FaaS  (published once to magic.solutionsuite.cn/api/faas)
                 ^
                 | Feishu pulls the link preview
signature URL = https://magic.solutionsuite.cn/r?fid=<record_id>`}</code></pre>
      <p>
        Slot value updates always go to the l.garyyang slot — the hook/update path
        is <strong>provider-agnostic</strong>. <code>magic-builder</code> only
        changes which preview URL Feishu embeds.
      </p>

      <h2>Configuration &amp; state</h2>
      <p>
        Provider-specific options stay under the provider id, so the generic
        presence model needs no Feishu-specific names. State is stored as JSON,
        guarded by a lock file, with two layers: <code>sessions</code>{" "}
        (event-derived truth) and <code>lastSlotUpdateAt</code> /{" "}
        <code>lastValue</code> (the renderer/provider debounce checkpoint).
      </p>

      <h2>Hook normalization</h2>
      <table>
        <thead><tr><th>Event</th><th>Result</th></tr></thead>
        <tbody>
          <tr><td>start event</td><td><code>running</code></td></tr>
          <tr><td>heartbeat event</td><td><code>running</code> with fresh <code>lastHeartbeatAt</code></td></tr>
          <tr><td>finish event</td><td><code>finished</code></td></tr>
          <tr><td>idle event</td><td><code>finished</code></td></tr>
        </tbody>
      </table>
      <p>
        Codex hooks always print <code>{"{}"}</code> (pass-through); Claude Code,
        Gemini CLI, opencode, and Pi run with <code>--silent</code>.
      </p>

      <h2>Session state machine</h2>
      <p>
        Three statuses — see{" "}
        <Link to="/guides/presence-semantics">Presence semantics</Link> for the
        full transition table and diagram. Default TTL is <strong>3 minutes</strong>.
      </p>

      <h2>Debounce &amp; provider updates</h2>
      <p>
        Hooks update local state immediately; the renderer compares the newly
        rendered value with <code>lastValue</code> / <code>lastSlotUpdateAt</code>.
        Normal updates obey the debounce interval; <code>update --force</code> and{" "}
        <code>reset --force</code> bypass it. Network I/O is kept{" "}
        <strong>outside</strong> the state mutation lock so a slow provider request
        can't block unrelated lifecycle writes.
      </p>

      <h2>Trust boundaries</h2>
      <ul>
        <li>Credentials live in Keychain (macOS), libsecret (Linux), or environment variables — <strong>never</strong> in git, the signature URL, logs, hook files, or local config files.</li>
        <li>On Linux, if neither env vars nor libsecret is available, credential operations fail with a clear error (no plaintext fallback).</li>
        <li>The provider writes only slot value changes, not Feishu profile fields.</li>
        <li>The <code>magic-builder</code> provider is the one deliberate exception to "credentials never leave the machine": its published FaaS embeds the l.garyyang slot bearer so it can read the slot on <code>magic.solutionsuite.cn</code>. Gated behind explicit operator action; the embedded value is the low-sensitivity slot bearer only, never the magic-builder token.</li>
      </ul>

      <h2>Failure model</h2>
      <table>
        <thead><tr><th>Failure</th><th>Expected behavior</th></tr></thead>
        <tbody>
          <tr><td>Agent exits without a finish hook</td><td>Session expires after TTL.</td></tr>
          <tr><td>Hook command fails</td><td>Coding agent continues; Codex receives <code>{"{}"}</code>.</td></tr>
          <tr><td>Provider returns 429</td><td>Local state remains correct; next non-debounced update can sync.</td></tr>
          <tr><td>Laptop sleeps / lid closes</td><td>macOS power watcher resets local and remote to 0. Linux TTL clears sessions.</td></tr>
          <tr><td>Sudden power loss</td><td>Wake reset (macOS) + TTL clear stale sessions.</td></tr>
          <tr><td>Keychain unavailable</td><td>Explicit env vars can supply token + slot id.</td></tr>
          <tr><td>Linux has no <code>secret-tool</code></td><td>Credential ops bail with a clear install instruction; env vars still work.</td></tr>
          <tr><td><code>npx</code> cache disappears after setup</td><td>Managed hooks keep working — they target the stable runtime/shim.</td></tr>
          <tr><td>Codex hooks present but not trusted</td><td>Setup prints a reminder; approve in Codex settings.</td></tr>
        </tbody>
      </table>

      <h2>Deeper reading</h2>
      <p>
        For the full idempotency table, observability model, Codex hook trust, and
        extension points, read{" "}
        <a href="https://github.com/PerfectPan/agent-presence">docs/architecture.md</a>{" "}
        in the repository directly.
      </p>
    </Doc>
  );
}
