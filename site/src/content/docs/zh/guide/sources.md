---
title: Sources
description: 添加、覆盖或禁用被 presence 统计的编码智能体。
---

**源(source)** 就是被统计在线状态的编码智能体。内置五个 —— `codex`、`claude`、`gemini`、`opencode`、`pi` —— 它们和你的配置项一起构成一张**源表(source table)**,你可以扩展、覆盖或禁用其中任意一项。什么都不配也没关系:不写配置时,这五个内置源即为默认。

源表就是 `~/.agent-presence/config.json` 里的 `plugins.sources`,按源 id 索引。同 id 条目**覆盖**内置,新 id **新增**一个源,`enabled: false` **禁用**一个源。随时查看生效的表:

```bash
agent-presence config show      # 包含合并后的 "sources" 表
agent-presence source list      # 只看这张表:id、来源、类型
```

## 添加一个源

有三种定义方式,选最简单够用的。

### 1. 安装一个包 —— `source add`

当源以 npm 包形式发布时(比如发到内网 registry 的内部智能体),这是最省事的路径:

```bash
agent-presence source add @your-scope/agent-presence-youragent --yes
# 内网 registry:
agent-presence source add @your-scope/agent-presence-youragent \
  --registry https://npm.internal.example --id youragent --yes
```

`add` 会把包装到一个独立目录(`~/.agent-presence/plugins/`),确认它导出了合法的源插件,再写进你的配置。`source remove <id>` 反注册并卸载它。

:::caution
源插件在 agent-presence **进程内**运行,能读取你的 slot 凭据。只添加你信任的包。`add` 会打印信任提示,并要求 `--yes` 或交互确认,且安装时带 `--ignore-scripts`。
:::

### 2. 声明式 —— 零代码

如果这个智能体的 hook payload 结构规整,直接在配置里映射字段即可,无需模块。每个字段的选项和内置解析器一致(`envKeys` / `payloadKeys` / `nestedPayloadKeys` / `payloadFirst`):

```jsonc
{
  "plugins": {
    "sources": {
      "youragent": {
        "match": {
          "sessionId": { "payloadKeys": ["session_id"], "payloadFirst": true },
          "project":   { "payloadKeys": ["cwd"], "payloadFirst": true },
          "event":     { "payloadKeys": ["hook_event_name"], "payloadFirst": true }
        }
      }
    }
  }
}
```

这一档不跑任何代码,是接入标准智能体的推荐方式。

### 3. 本地 handler 模块

payload 有怪癖时(嵌套 id、事件重映射),指向一个 default 导出为源插件的 ES 模块:

```jsonc
{
  "plugins": {
    "sources": {
      "youragent": { "handler": "/Users/me/.agent-presence/sources/youragent.mjs" }
    }
  }
}
```

```js
// youragent.mjs
export default {
  id: 'youragent',
  resolveHookContext(payload, env) {
    return { sessionId: payload.session_id, project: payload.cwd, event: payload.hook_event_name };
  }
};
```

请用你自己拥有的目录下的**绝对路径**。agent-presence 会拒绝软链接、非本人属主或全局可写的 handler;当 `config.json` 本身全局可写时,会完全忽略 `handler` 条目。

一旦某个源解析出了 `sessionId`,你的智能体需要调用 hook,事件才能到达 agent-presence:

```bash
agent-presence hook --source youragent --event SessionStart --silent
```

把它接进你智能体自己的生命周期 hook(payload 走 stdin)。

## 覆盖内置源

用内置 id 配上你自己的 `match` 或 `handler`。比如改 `codex` 读取会话 id 的方式:

```jsonc
{ "plugins": { "sources": { "codex": { "match": { "sessionId": { "payloadKeys": ["my_id"], "payloadFirst": true } } } } } }
```

## 禁用内置源

```jsonc
{ "plugins": { "sources": { "gemini": { "enabled": false } } } }
```

`gemini` 随即从计数和 `source list` 里消失。

## 解析与信任机制

每个表条目按类型解析:

- **`builtin:<id>`**(内置默认)—— 可信的一方解析器,拿到原始环境变量。
- **`match`** —— 由你的字段规则编译而来,不跑代码。
- **`handler`** —— 进程内运行的 JS 模块;带护栏(剥离凭据的环境、路径/配置属主校验)且 fail-open,坏掉的源永远不会阻塞 hook。

信任跟着 `builtin:` 标记走,而不是跟着 id —— 所以用你自己的 handler 覆盖内置源时,仍走护栏路径。

`agent-presence uninstall --all` 会连同 hook 和状态一起移除已安装的源包。
