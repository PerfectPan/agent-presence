import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "安全 — Agent Presence" }];
}

export default function ZhSecurity() {
  return (
    <Doc
      locale="zh"
      title="安全"
      source={
        <><a href="https://github.com/PerfectPan/agent-presence">SECURITY.md</a>(英文为单一真相来源)</>
      }
    >
      <h2>报告漏洞</h2>
      <p>
        如果报告含密钥、漏洞细节、私有基础设施或用户专属数据,<strong>不要</strong>通过公开 issue 报告。
        私下报告请直接通过 GitHub 联系仓库 owner,或使用仓库安全公告流程(若已开启)。
      </p>
      <p>请包含:</p>
      <ul>
        <li>受影响的版本或 commit</li>
        <li>操作系统与运行时详情</li>
        <li>复现步骤</li>
        <li>预期行为</li>
        <li>实际行为</li>
        <li>影响评估</li>
      </ul>

      <h2>敏感数据指引</h2>
      <p>
        不要在 issue、PR、commit、日志、截图或测试夹具里包含 token、私钥、本地凭据、内部主机名或个人
        文件系统路径。
      </p>
      <p>
        Agent Presence 默认把 provider 凭据存在 Keychain,环境变量作为显式自动化覆盖。凭据不得嵌入
        hook 命令、生成的签名 URL、README 示例、测试或 Changesets。
      </p>

      <h2>凭据处理</h2>
      <table>
        <thead><tr><th>平台</th><th>存储</th><th>fallback</th></tr></thead>
        <tbody>
          <tr><td>macOS</td><td>Keychain</td><td>环境变量</td></tr>
          <tr><td>Linux</td><td>libsecret(<code>secret-tool</code>)</td><td>环境变量 —— <strong>无明文 fallback</strong></td></tr>
        </tbody>
      </table>
      <p>Linux 上,若环境变量和 libsecret 都不可用,凭据操作会以明确错误退出。</p>

      <h2>范围</h2>
      <p>
        在范围内:凭据处理、hook 命令安全、签名 URL 泄漏、供应链(lockfile、安装脚本、发布 token)。
      </p>

      <h2>供应链</h2>
      <p>
        仓库包管理用 <code>packageManager</code> 固定的 pnpm 版本,以及 <code>pnpm-workspace.yaml</code> 里的安全设置:
      </p>
      <ul>
        <li><code>minimumReleaseAge</code> / <code>minimumReleaseAgeStrict</code> —— 接受新发布包前等待</li>
        <li><code>blockExoticSubdeps</code> —— 阻断传递性 git/tarball URL 依赖</li>
        <li><code>strictDepBuilds</code> —— 未审查依赖构建脚本则失败</li>
        <li>CI 用 frozen lockfile 安装并禁用安装脚本</li>
      </ul>
      <p>
        发布走 Changesets 与 npm Trusted Publishing。<strong>不要</strong>为默认发布路径在仓库 secret 里
        加常驻 npm 发布 token。
      </p>
    </Doc>
  );
}
