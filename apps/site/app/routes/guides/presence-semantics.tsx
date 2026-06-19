import { Link } from "react-router";
import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "Presence semantics — Agent Presence" }];
}

export default function PresenceSemantics() {
  return (
    <Doc
      locale="en"
      title="Presence semantics"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>{" "}
          and <a href="https://github.com/PerfectPan/agent-presence">docs/architecture.md</a>
        </>
      }
    >
      <p>
        This project counts agents that are <strong>actually working</strong>, not
        merely open terminal windows. Presence is derived from agent lifecycle
        hooks — it never scans processes or terminal windows.
      </p>

      <h2>State machine</h2>
      <p>
        Three statuses: <code>running</code> (explicit local evidence of work),{" "}
        <code>finished</code> (explicit finish/idle event ended the turn), and{" "}
        <code>expired</code> (TTL-inferred inactivity, default{" "}
        <strong>3 minutes</strong>).
      </p>
      <pre><code>{`SessionStart / UserPromptSubmit / PreToolUse / PostToolUse -> running / heartbeat
Pi before_agent_start / turn_start / tool_execution_*      -> running / heartbeat
Stop / SessionEnd / session.idle / agent_end / session_shutdown -> finished
No heartbeat for 3 minutes                                    -> expired
Expired + later live heartbeat                                -> running again
Laptop sleep / lid close / screen sleep                       -> reset to 0
Wake                                                          -> reset to 0 again`}</code></pre>
      <p>
        <code>finished</code> is explicit and ignores late ordinary heartbeats.{" "}
        <code>expired</code> is TTL-inferred inactivity, so a later live heartbeat
        can reopen the same session.
      </p>

      <h2>State diagram</h2>
      <p>
        The diagram below is the project's canonical state machine, reused verbatim
        from <code>docs/assets/presence-state-machine.svg</code>.
      </p>
      <p>
        <img
          src="/assets/presence-state-machine.svg"
          alt="Agent Presence Session State Machine: missing, running (counted), expired (inactive), finished (inactive), and reset states with numbered transitions."
          style={{ width: "100%", maxWidth: "60rem" }}
        />
      </p>

      <h2>Key distinction</h2>
      <ul>
        <li>
          <strong><code>finished</code></strong> comes from an explicit lifecycle
          event and protects the state from late async hook traffic after a turn
          has stopped.
        </li>
        <li>
          <strong><code>expired</code></strong> is only an inactivity inference, so
          a later live heartbeat from the same session can reopen it.
        </li>
      </ul>
      <p>Only <code>running</code> sessions inside TTL contribute to the rendered active count.</p>

      <h2>Pi-specific semantics</h2>
      <p>
        For Pi specifically, opening the <code>pi</code> TUI on its own is{" "}
        <strong>not</strong> counted as active: presence only activates when Pi
        fires <code>before_agent_start</code>, which happens once the user actually
        submits a task. This avoids "Pi is open but doing nothing" being miscounted.
      </p>

      <h2>Default render</h2>
      <pre><code>{`0 -> AI 牛马暂未开工
1 -> 1 个 AI 牛马正在搬砖 | codex 1
N -> N 个 AI 牛马正在搬砖 | codex W · claude X · gemini Y · opencode Z · pi P`}</code></pre>
      <p>
        The value is capped at <strong>200 characters</strong>. To change the
        wording, see <Link to="/guides/render-templates">Render Templates</Link>.
      </p>

      <h2>Recovery without process scanning</h2>
      <p>This model gives two recovery paths without ever scanning processes:</p>
      <ol>
        <li>Missed finish hooks are cleaned by <strong>TTL expiry</strong>.</li>
        <li>Long-running sessions re-activate on the next <strong>real heartbeat</strong>.</li>
      </ol>
      <p>
        Lid close / sleep / wake run <code>agent-presence reset --force --silent</code>{" "}
        (macOS power watcher). On Linux the watcher is skipped and the 3-minute TTL
        clears expired sessions.
      </p>
    </Doc>
  );
}
