import { Link } from "react-router";
import { Doc, Note } from "~/components/Doc";

export function meta() {
  return [{ title: "Contributing — Agent Presence" }];
}

export default function Contributing() {
  return (
    <Doc
      locale="en"
      title="Contributing"
      source={
        <>
          <a href="https://github.com/PerfectPan/agent-presence">CONTRIBUTING.md</a>{" "}
          in the repository
        </>
      }
    >
      <h2>Development setup</h2>
      <pre><code>{`corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
node dist/src/cli.js --help`}</code></pre>

      <h2>Required checks</h2>
      <pre><code>{`pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
pnpm pack --dry-run`}</code></pre>

      <h2>Contribution flow</h2>
      <ol>
        <li>Open an issue or discussion for ambiguous work.</li>
        <li>Write an RFC for substantial changes.</li>
        <li>Create a focused branch.</li>
        <li>Add or update tests for behavior changes.</li>
        <li>Update <code>CHANGELOG.md</code> (via Changesets) for user-facing changes.</li>
        <li>Run format, lint, test, and build checks.</li>
        <li>Open a pull request with motivation, implementation notes, validation, and follow-up risks.</li>
      </ol>
      <Note>
        Small typo corrections, narrow documentation fixes, and repository metadata
        updates do <strong>not</strong> need an RFC.
      </Note>

      <h2>When to write an RFC</h2>
      <p>
        A change affects any of: public behavior; install, deploy, or rollback
        safety; trust boundaries; configuration shape; release process; repository
        structure; long-term integration strategy. RFCs should describe the
        problem, goals, non-goals, proposed design, alternatives, rollout plan, and
        risks.
      </p>

      <h2>PR expectations</h2>
      <p>Every PR should answer:</p>
      <ul>
        <li>What changed?</li>
        <li>Why is this change needed?</li>
        <li>How was it tested?</li>
        <li>Are there follow-up tasks or risks?</li>
      </ul>

      <h2>Repository hygiene</h2>
      <p>
        Do <strong>not</strong> commit private tokens, local config, generated
        workspaces, internal hostnames, or personal filesystem paths. Use the pinned
        pnpm version from <code>packageManager</code>. Do not commit{" "}
        <code>package-lock.json</code>, local <code>.npmrc</code> credentials,
        generated <code>dist/</code>, or <code>node_modules/</code>. See{" "}
        <Link to="/project/security">Security</Link> for the sensitive-data policy.
      </p>

      <h2>Changesets</h2>
      <p>
        This repository uses Changesets. For user-facing changes, add a changeset in
        the same PR:
      </p>
      <pre><code>{`pnpm run changeset`}</code></pre>
      <p>
        Releases go through npm Trusted Publishing / OIDC — no long-lived npm write
        token in repository secrets.
      </p>
    </Doc>
  );
}
