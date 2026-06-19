import { Doc, Note } from "~/components/Doc";

export function meta() {
  return [{ title: "Commands — Agent Presence" }];
}

export default function Commands() {
  return (
    <Doc
      locale="en"
      title="Commands"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>
        </>
      }
    >
      <p>
        Bare commands target the default <code>magic-builder</code> provider. Pass{" "}
        <code>--provider feishu-signature</code> to target the direct{" "}
        <code>l.garyyang.work</code> preview instead.
      </p>

      <h2>Setup &amp; login</h2>
      <pre><code>{`agent-presence setup                       # default provider (magic-builder)
agent-presence setup --login               # force a fresh login
agent-presence setup --skip-login          # refresh hooks without login checks
agent-presence setup --no-hooks            # skip installing hooks
agent-presence setup --hook-command absolute  # absolute node + CLI paths (restricted PATH)
agent-presence login --provider feishu-signature  # interactive QR login for the slot backend`}</code></pre>

      <h2>Output commands</h2>
      <pre><code>{`agent-presence url                         # default (magic-builder) signature URL
agent-presence status                      # script-safe local status
agent-presence status --remote             # also read the live remote slot/preview
agent-presence usage                       # today + last 7 days
agent-presence usage --days 7              # a single calendar-day window
agent-presence usage --days 1 --json       # structured output for scripts`}</code></pre>

      <h2>Write / reset</h2>
      <pre><code>{`agent-presence update --force              # push a rendered update (script-safe, bypasses debounce)
agent-presence reset --force               # reset presence to 0
agent-presence reset --force --silent      # what the power watcher runs`}</code></pre>

      <h2>Uninstall</h2>
      <pre><code>{`agent-presence uninstall                   # remove hooks/watcher, keep creds + state
agent-presence uninstall --credentials     # also clear login + slot config
agent-presence uninstall --all             # hooks + creds + config + state + managed runtime`}</code></pre>

      <h2>Config</h2>
      <pre><code>{`agent-presence config show
agent-presence config render --zero "..." --one "..." --many "..."
agent-presence config provider feishu-signature \\
  --base-url "https://l.garyyang.work" \\
  --preview-base-url "https://l.garyyang.work/" \\
  --image-key "img_xxx" \\
  --target-url "https://example.com"`}</code></pre>

      <h2>Hook (direct invocation)</h2>
      <p>Hooks are installed automatically by <code>setup</code>, but can be called directly:</p>
      <pre><code>{`agent-presence hook --source codex    --event SessionStart
agent-presence hook --source claude   --event SessionStart --silent
agent-presence hook --source gemini   --event SessionStart --silent
agent-presence hook --source opencode --event SessionStart --silent
agent-presence hook --source pi       --event SessionStart --silent
agent-presence hook --source codex    --event Stop`}</code></pre>
      <Note title="Hook output">
        Hook commands never block the coding agent. <strong>Codex hooks print <code>{"{}"}</code></strong>{" "}
        (pass-through); Claude, Gemini, opencode, and Pi hooks run <code>--silent</code>.
      </Note>

      <h2>Interactive vs script-safe</h2>
      <p>
        <code>login</code>, <code>setup</code>, and interactive <code>config</code>{" "}
        flows use Clack prompts. <code>hook</code>, <code>status</code>,{" "}
        <code>update</code>, <code>reset</code>, and <code>url</code> commands keep{" "}
        <strong>script-safe</strong> output (plain JSON or silent).
      </p>
    </Doc>
  );
}
