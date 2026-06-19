import { Doc, Caution } from "~/components/Doc";

export function meta() {
  return [{ title: "Providers — Agent Presence" }];
}

export default function Providers() {
  return (
    <Doc
      locale="en"
      title="Providers"
      source={
        <>
          the repository <a href="https://github.com/PerfectPan/agent-presence">README.md</a>
        </>
      }
    >
      <p>
        The default provider id is <strong><code>magic-builder</code></strong>. It is a
        preview front-end built on the <code>feishu-signature</code> slot backend.
        <code>feishu-signature</code> is the underlying slot storage{" "}
        <strong>and</strong> the direct-preview alternative. Either way, presence
        value updates always flow to the <code>feishu-signature</code> slot —
        provider choice only changes which preview URL Feishu embeds.
      </p>
      <pre><code>{`hooks ──> l.garyyang slot (always)
              │
              ├── magic-builder FaaS (default)  reads /api/slot/info each preview fetch
              │        └──> https://magic.solutionsuite.cn/r?fid=<record_id>
              │
              └── feishu-signature direct preview (--provider feishu-signature)
                       └──> https://l.garyyang.work/?t2=<base62(slot id)>`}</code></pre>

      <h2><code>magic-builder</code> (Magic-Builder FaaS bridge, default)</h2>
      <p>
        <code>magic-builder</code> is the default provider. It is a{" "}
        <strong>preview front-end, not a separate storage backend</strong>: it
        publishes a small FaaS to <code>magic.solutionsuite.cn</code>, and on every
        Feishu link-preview fetch that FaaS runs server-side, reads the current
        value from the l.garyyang slot, and returns it as the preview title.
      </p>
      <p>
        It is the default because Feishu may <strong>not</strong> render the direct{" "}
        <code>l.garyyang.work</code> page (it can tighten the iframe whitelist for
        personal-signature previews), and the <code>magic.solutionsuite.cn</code>{" "}
        front-end is the more reliable target.
      </p>
      <p>
        <code>magic-builder</code> depends on <code>feishu-signature</code>: setting
        it up still requires (1) the l.garyyang QR login (stores the slot
        credential) and (2) a separate Magic-Builder token to publish the FaaS.
        There is no way around needing the l.garyyang login.
      </p>
      <pre><code>{`# The first setup runs the l.garyyang QR login (storing the slot credential)
# and prompts for a Magic-Builder token. To reuse an existing login run
# \`agent-presence login --provider feishu-signature\` first, then:
agent-presence setup --hook-command absolute`}</code></pre>

      <h3>Getting a Magic-Builder token</h3>
      <p>
        In an interactive terminal with no token configured, setup prints the token
        instructions and prompts you to paste the token, then stores it in the OS
        keyring (Keychain on macOS, libsecret on Linux).
      </p>
      <ol>
        <li>In Feishu, open the 妙笔 (Magic-Builder) bot: <a href="https://applink.larkoffice.com/T94fcr4NqQPz">applink.larkoffice.com/T94fcr4NqQPz</a></li>
        <li>Send the message <code>dev</code>.</li>
        <li>Copy the token from its reply.</li>
      </ol>
      <p>Non-interactive environments can supply the token without the prompt:</p>
      <pre><code>{`export MAGIC_TOKEN=<token>          # one-off, highest precedence
# or, skill-pack compatible plaintext file (read, never written by this CLI):
echo <token> > ~/.magic-token && chmod 600 ~/.magic-token`}</code></pre>
      <p>
        <strong>Token resolution order:</strong> <code>MAGIC_TOKEN</code> env → OS
        keyring → <code>~/.magic-token</code> → <code>&lt;cwd&gt;/.magic-token</code>.
      </p>

      <h3>What setup publishes</h3>
      <p>
        <code>setup</code> builds a CommonJS FaaS that embeds your slot id and
        bearer, POSTs it to <code>https://magic.solutionsuite.cn/api/faas</code>,
        and stores the returned <code>record_id</code> under{" "}
        <code>providers.magic-builder.faasId</code>. The resulting signature URL is:
      </p>
      <pre><code>{`https://magic.solutionsuite.cn/r?fid=<record_id>`}</code></pre>
      <p>
        Re-running <code>setup --provider magic-builder</code> updates the same FaaS
        in place (idempotent). Hooks continue to write into the l.garyyang slot
        exactly as before — the FaaS pulls from <code>/api/slot/info</code> each
        time Feishu refreshes the preview (<strong>default cache 60s</strong>).
      </p>

      <h3>Inspecting the live preview</h3>
      <pre><code>{`agent-presence status --provider magic-builder --remote
# → .remote.faas.title, .remote.faas.expireStrategy`}</code></pre>

      <h3>Overrides</h3>
      <pre><code>{`export MAGIC_TOKEN=...                                # publish token
export AGENT_PRESENCE_MAGIC_BUILDER_BASE_URL=...      # override magic.solutionsuite.cn
export AGENT_PRESENCE_MAGIC_BUILDER_FAAS_ID=rec_...   # pin an existing FaaS record id
export AGENT_PRESENCE_MAGIC_BUILDER_FAAS_NAME=...     # override default agent_presence_preview
export AGENT_PRESENCE_MAGIC_BUILDER_FALLBACK_TITLE=...# rendered when the slot read fails`}</code></pre>
      <Caution title="Trust-boundary trade-off">
        The published FaaS embeds your l.garyyang slot bearer so it can read the
        slot value on <code>magic.solutionsuite.cn</code>. This is the one
        deliberate exception to "credentials never leave the machine". It is gated
        behind explicit operator action; the embedded value is the
        low-sensitivity slot bearer only, <strong>never</strong> the magic-builder
        token (which stays in the OS keyring). Rotating that bearer requires
        re-running <code>setup --provider magic-builder</code> to re-publish.
      </Caution>

      <h2><code>feishu-signature</code> (slot backend + direct-preview alternative)</h2>
      <p>
        <code>feishu-signature</code> is the underlying slot backend that stores
        presence values; the default <code>magic-builder</code> provider is built
        on top of it. Selecting it directly (via{" "}
        <code>--provider feishu-signature</code>) skips the Magic-Builder FaaS and
        serves the preview straight from <code>l.garyyang.work</code>, which needs{" "}
        <strong>no</strong> Magic-Builder token. Use it when Feishu does render the{" "}
        <code>l.garyyang.work</code> page.
      </p>
      <p>Its current slot backend is <code>l.garyyang.work</code>:</p>
      <pre><code>{`GET  /api/slot/wechat/qrcode
GET  /api/slot/wechat/login-status?sceneId=...
POST /api/slot/update
GET  /api/slot/info`}</code></pre>
      <p>The direct preview URL contains only an encoded slot helper, not credentials:</p>
      <pre><code>{`https://l.garyyang.work/?t2=<base62({{slot id="slot_xxx"}})>`}</code></pre>
      <p>Configure provider-specific link preview fields:</p>
      <pre><code>{`agent-presence config provider feishu-signature \\
  --base-url "https://l.garyyang.work" \\
  --preview-base-url "https://l.garyyang.work/" \\
  --image-key "img_xxx" \\
  --target-url "https://example.com"`}</code></pre>
      <p>Credentials are stored in Keychain (macOS) / libsecret (Linux) by default. Env overrides:</p>
      <pre><code>{`export AGENT_PRESENCE_TOKEN=...
export AGENT_PRESENCE_SLOT_ID=slot_xxx
export AGENT_PRESENCE_FEISHU_SIGNATURE_BASE_URL="https://l.garyyang.work"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_BASE_URL="https://l.garyyang.work/"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_IMAGE_KEY="img_xxx"
export AGENT_PRESENCE_FEISHU_SIGNATURE_PREVIEW_TARGET_URL="https://example.com"`}</code></pre>
      <p>
        Token and slot credentials are not written to git and are not embedded in
        the signature URL.
      </p>
    </Doc>
  );
}
