import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "Security — Agent Presence" }];
}

export default function Security() {
  return (
    <Doc
      locale="en"
      title="Security"
      source={
        <>
          <a href="https://github.com/PerfectPan/agent-presence">SECURITY.md</a>{" "}
          in the repository
        </>
      }
    >
      <h2>Reporting a vulnerability</h2>
      <p>
        Do <strong>not</strong> report via a public issue if the report includes
        secrets, exploit details, private infrastructure, or user-specific data. For
        private reports, contact the repository owner directly through GitHub, or
        use the repository security advisory flow if enabled.
      </p>
      <p>Include:</p>
      <ul>
        <li>affected version or commit</li>
        <li>operating system and runtime details</li>
        <li>reproduction steps</li>
        <li>expected behavior</li>
        <li>actual behavior</li>
        <li>impact assessment</li>
      </ul>

      <h2>Sensitive data guidance</h2>
      <p>
        Do not include tokens, private keys, local credentials, internal hostnames,
        or personal filesystem paths in issues, pull requests, commits, logs,
        screenshots, or test fixtures.
      </p>
      <p>
        Agent Presence stores provider credentials in Keychain by default, with
        environment variables as the explicit automation override. Credentials must
        not be embedded in hook commands, generated signature URLs, README examples,
        tests, or Changesets.
      </p>

      <h2>Credential handling</h2>
      <table>
        <thead><tr><th>Platform</th><th>Storage</th><th>Fallback</th></tr></thead>
        <tbody>
          <tr><td>macOS</td><td>Keychain</td><td>environment variables</td></tr>
          <tr><td>Linux</td><td>libsecret (<code>secret-tool</code>)</td><td>environment variables — <strong>no plaintext fallback</strong></td></tr>
        </tbody>
      </table>
      <p>
        On Linux, if neither environment variables nor libsecret is available,
        credential operations fail with a clear error.
      </p>

      <h2>Scope</h2>
      <p>
        In scope: credential handling, hook command safety, signature-URL leakage,
        and supply chain (lockfile, install scripts, publish tokens).
      </p>

      <h2>Supply chain</h2>
      <p>
        Repository package management uses the pinned pnpm version in{" "}
        <code>packageManager</code> and the safety settings in{" "}
        <code>pnpm-workspace.yaml</code>:
      </p>
      <ul>
        <li><code>minimumReleaseAge</code> / <code>minimumReleaseAgeStrict</code> — wait before accepting newly published packages</li>
        <li><code>blockExoticSubdeps</code> — block transitive git/tarball URL dependencies</li>
        <li><code>strictDepBuilds</code> — fail on unreviewed dependency build scripts</li>
        <li>frozen lockfile installs with install scripts disabled in CI</li>
      </ul>
      <p>
        Releases go through Changesets and npm Trusted Publishing. Do{" "}
        <strong>not</strong> add long-lived npm publish tokens to repository secrets
        for the default release path.
      </p>
    </Doc>
  );
}
