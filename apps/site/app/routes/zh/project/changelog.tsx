import { Doc } from "~/components/Doc";

export function meta() {
  return [{ title: "更新日志 — Agent Presence" }];
}

export default function ZhChangelog() {
  return (
    <Doc
      locale="zh"
      title="更新日志"
      source={
        <><a href="https://github.com/PerfectPan/agent-presence">CHANGELOG.md</a>(权威,由 Changesets 生成,英文为单一真相来源)</>
      }
    >
      <p>
        权威 changelog 是仓库的 <code>CHANGELOG.md</code>,由 Changesets 生成。本页汇总近期版本 ——
        完整历史请读源文件。
      </p>

      <h2>0.6.0</h2>
      <h3>把 <code>magic-builder</code> 设为默认 provider</h3>
      <p>
        飞书的链接预览管道不能可靠渲染 <code>l.garyyang.work</code> 直连页,而
        <code>magic.solutionsuite.cn</code> FaaS 前端被接受 —— 所以裸 <code>agent-presence setup</code> /
        <code>url</code> / <code>status</code> 现在指向 <code>magic-builder</code>。slot 值更新仍流向
        l.garyyang 后端(推送路径与 provider 无关),<code>feishu-signature</code> 仍作为底层 slot 后端和
        直连预览备选,通过 <code>--provider feishu-signature</code> 使用。
      </p>
      <p>
        现有安装不受影响:<code>login</code> 会在 config 里持久化显式 <code>provider</code>,所以新默认只对
        全新 setup 生效。新用户在 setup 时会被提示输入 Magic-Builder token(直连
        <code>feishu-signature</code> 预览无需 token)。
      </p>

      <h3>token 用量窗口改为自然日对齐</h3>
      <p>
        <code>今日</code> 从本地 0 点起算(并在 00:00 归零),而不是像 <code>[now-24h, now)</code> 滚动窗口那样
        随旧活动老化而<em>中途下降</em>。N 天窗口覆盖包含今天在内的 N 个本地自然日。
      </p>
      <p>
        一个缓存的签名 badge,若其整个窗口自上次计算以来已翻过(<code>今日</code> 过一个午夜、
        <code>近N天</code> 过 N 天),现在会渲染成 <code>—</code>,直到下次会话边界刷新重新计算。
        你在模板里写的标签不变。
      </p>

      <h2>0.5.0</h2>
      <h3>新增 <code>agent-presence usage</code></h3>
      <p>
        ccusage 风格的 token 消耗。事后扫描 Claude、Codex、Pi 的会话记录(Gemini 不在本地持久化
        token 用量),按可配置窗口(默认近 1d 与 7d)报告各 source 的 token 与估算美元成本。签名可通过
        渲染模板变量 <code>{"{usage}"}</code> / <code>{"{usage_1d}"}</code> / <code>{"{usage_7d}"}</code> /
        <code>{"{usage_Nd}"}</code> 展示用量,或用 <code>usage.showInSignature</code> 做零配置 badge。
        badge 只在会话边界刷新。价格可在 <code>config.usage.pricing</code> 按模型覆盖。
      </p>

      <h2>0.4.0</h2>
      <h3>新增 <code>magic-builder</code> provider</h3>
      <p>
        签名 URL 的备选(现为默认)前端。向 <code>magic.solutionsuite.cn/api/faas</code> 发布一个小 CommonJS FaaS,
        并产出 <code>https://magic.solutionsuite.cn/r?fid=&lt;record_id&gt;</code>。hook 仍写入 l.garyyang slot;
        FaaS 每次飞书预览刷新时从 <code>/api/slot/info</code> 拉取(默认缓存 60s)。
      </p>
      <h3>新增 Pi Coding Agent</h3>
      <p>
        支持 <code>@earendil-works/pi-coding-agent</code> 作为 presence source。setup 在
        <code>~/.pi/agent/extensions/agent-presence.ts</code> 安装托管扩展,桥接 Pi 生命周期事件。
      </p>

      <h2>更早版本</h2>
      <p>
        0.3.x 加了 Linux 平台支持、China-time logfmt 日志、reopen 过期 session 修复。
        0.2.x 加了 Gemini CLI 支持、<code>~/.agent-presence</code> home 与遗留迁移、绝对路径 hook 命令安装。
        0.1.x 是初始版本(仅 macOS),含 Clack 提示与 hook/state/render/provider 模块拆分。
      </p>
      <p>
        完整精确历史见{" "}
        <a href="https://github.com/PerfectPan/agent-presence">CHANGELOG.md</a>。
      </p>
    </Doc>
  );
}
