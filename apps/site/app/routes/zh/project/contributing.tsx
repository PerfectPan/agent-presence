import { Link } from "react-router";
import { Doc, Note } from "~/components/Doc";

export function meta() {
  return [{ title: "贡献 — Agent Presence" }];
}

export default function ZhContributing() {
  return (
    <Doc
      locale="zh"
      title="贡献"
      source={
        <><a href="https://github.com/PerfectPan/agent-presence">CONTRIBUTING.md</a>(英文为单一真相来源)</>
      }
    >
      <h2>开发环境</h2>
      <pre><code>{`corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
node dist/src/cli.js --help`}</code></pre>

      <h2>必跑检查</h2>
      <pre><code>{`pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run typecheck
pnpm run build
pnpm pack --dry-run`}</code></pre>

      <h2>贡献流程</h2>
      <ol>
        <li>有歧义的工作先开 issue 或讨论。</li>
        <li>实质性改动写 RFC。</li>
        <li>创建聚焦的分支。</li>
        <li>为行为变更添加或更新测试。</li>
        <li>用户可见变更更新 <code>CHANGELOG.md</code>(经 Changesets)。</li>
        <li>跑格式、lint、测试、构建检查。</li>
        <li>开 PR,含动机、实现说明、验证、后续风险。</li>
      </ol>
      <Note title="提示">
        小的笔误修正、窄范围文档修复、仓库元数据更新<strong>不需要</strong> RFC。
      </Note>

      <h2>何时写 RFC</h2>
      <p>
        变更影响以下任一项:公开行为;安装、部署或回滚安全;信任边界;配置形态;发布流程;仓库结构;
        长期集成策略。RFC 应描述问题、目标、非目标、提议设计、备选方案、滚动计划与风险。
      </p>

      <h2>PR 要求</h2>
      <p>每个 PR 应回答:</p>
      <ul>
        <li>改了什么?</li>
        <li>为什么需要这个变更?</li>
        <li>怎么测的?</li>
        <li>有没有后续任务或风险?</li>
      </ul>

      <h2>仓库卫生</h2>
      <p>
        <strong>不要</strong>提交私有 token、本地配置、生成的工作区、内部主机名或个人文件系统路径。
        用 <code>packageManager</code> 固定的 pnpm 版本。不要提交 <code>package-lock.json</code>、
        本地 <code>.npmrc</code> 凭据、生成的 <code>dist/</code> 或 <code>node_modules/</code>。
        敏感数据策略见 <Link to="/zh/project/security">安全</Link>。
      </p>

      <h2>Changesets</h2>
      <p>本仓库用 Changesets。用户可见变更在同一 PR 里加 changeset:</p>
      <pre><code>{`pnpm run changeset`}</code></pre>
      <p>
        发布走 npm Trusted Publishing / OIDC —— 仓库 secret 里无常驻 npm 写 token。
      </p>
    </Doc>
  );
}
