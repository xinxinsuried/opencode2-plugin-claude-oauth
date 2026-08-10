# opencode2-plugin-claude-oauth

给 **opencode2**（`@opencode-ai/cli`，next 通道）补回 Anthropic 登录：用 Claude Pro / Max 订阅直接跑 `anthropic/*` 模型，不需要 API Key。

```
$ opencode2 auth login
  Anthropic
  ├─ Claude Pro/Max subscription                 ← 浏览器 OAuth（PKCE）
  ├─ Reuse the Claude Code login on this machine ← 直接复用本机 claude 的登录
  ├─ API key
  └─ ANTHROPIC_API_KEY
```

顺带在侧边栏显示订阅的 5 小时 / 7 天限额：

```
Claude limits
├─ 5h  ███████░░░   66%  3h50m
└─ 7d  ███░░░░░░░   34%  5d18h
```

opencode 1.3 之后官方移除了内置 Anthropic 登录，只留下 `key` / `env` 两种方式。opencode2 的 `anthropic` provider 和 integration 都还在，缺的只是 `oauth` method —— 这个插件把它加回来，并接管请求头和请求体，让订阅 token 能正常通过 `/v1/messages`。

原型来自 [griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth)（opencode 1.x），本仓库按 opencode2 的插件 API 重写。

## 要求

- `opencode2`（`@opencode-ai/cli@next`）
- `bun`
- 一个 Claude Pro / Max 订阅

## 安装

```bash
git clone https://github.com/xinxinsuried/opencode2-plugin-claude-oauth \
  ~/.config/opencode/plugins/claude-oauth
cd ~/.config/opencode/plugins/claude-oauth
bun install
```

在 `~/.config/opencode/opencode.jsonc` 的 `plugins` 里加上 `server.ts` 的**绝对路径**：

```jsonc
{
  "plugins": ["/home/you/.config/opencode/plugins/claude-oauth/server.ts"]
}
```

Windows 用正斜杠：`"C:/Users/you/.config/opencode/plugins/claude-oauth/server.ts"`。

> 必须指向文件。目录形式宿主会去 resolve `<dir>/index`，编译版的 `import.meta.resolve` 不补扩展名，会报 ENOENT。
>
> 也可以不改配置：把入口文件直接放在 `~/.config/opencode/plugins/*.ts`（宿主会扫描 `{plugin,plugins}/*.{ts,js}`，**不递归子目录**）。用子目录的话就得走上面的配置写法。

侧边栏是 TUI 侧插件，另外在 `~/.config/opencode/cli.json` 的 `plugins` 里加上 `tui.tsx` 的绝对路径：

```jsonc
{
  "plugins": ["C:/Users/you/.config/opencode/plugins/claude-oauth/tui.tsx"]
}
```

重启后台服务，确认插件加载成功：

```bash
opencode2 service restart
opencode2 plugin list        # 应该能看到 claude-oauth
```

> 服务端插件只有入口文件带 `?mtime=` 缓存失效，改了 `src/` 下的模块必须 `opencode2 service restart`，光存盘不会生效。

## 使用

### 1. 登录

```bash
opencode2 auth login
```

选 **Anthropic**，然后二选一：

| 方式 | 适用场景 | 流程 |
| --- | --- | --- |
| `Claude Pro/Max subscription` | 任何机器 | 打开浏览器授权 → 页面给出 `code#state` → 粘回终端 |
| `Reuse the Claude Code login on this machine` | 本机装了 Claude Code 且已登录 | 直接读取凭据，无需浏览器；多账号时会让你选 |

第二种只在本机能读到凭据时才出现，读取位置：

- macOS：Keychain 条目 `Claude Code-credentials`，读不到再退回文件
- 全平台文件：`$CLAUDE_CONFIG_DIR/.credentials.json`，默认 `~/.claude/.credentials.json`

### 2. 选模型开跑

```bash
opencode2 run --model anthropic/claude-haiku-4-5 "reply with PONG"
```

TUI 里 `ctrl+p` → 切模型，`anthropic/*` 登录后自动出现在列表里（15 个模型，来自 models.dev）。

订阅制不按 token 计费，所以插件会把 `anthropic/*` 的价格清零，session 里不会再显示虚构的花费。

### 3. 限额侧边栏

默认开启。侧边栏顶部显示订阅的两个滚动窗口：

```
Claude limits
├─ 5h  ███████░░░   66%  3h50m
└─ 7d  ███░░░░░░░   34%  5d18h
```

右边是距离该窗口重置还有多久。超过 75% 转警告色，超过 90% 或被 Anthropic 判为 `rejected` 转错误色。

数据来自每次 `/v1/messages` 响应自带的 `anthropic-ratelimit-unified-*` 头，所以刷新它不额外花请求；开着 TUI 还没发过消息时，插件会用 `/api/oauth/usage` 补一次初始值。

关掉它：

```jsonc
// opencode.jsonc 和 cli.json 都改成对象形式
{ "plugins": [{ "package": "…/claude-oauth/server.ts", "options": { "usage": false } }] }
```

或者设 `CLAUDE_OAUTH_USAGE=0`，服务端和 TUI 侧一起关。

### 4. token 过期

不用管。凭据过期前 5 分钟，宿主会自己调插件注册的 `refresh` 换新 token 并落库。

### 5. 退出登录

```bash
opencode2 auth login    # 重新选一次方式即可覆盖
```

或直接删掉 `anthropic` 的 credential。

## 它到底做了什么

opencode2 把 OAuth 凭据解析成 `x-api-key` 塞给 `@ai-sdk/anthropic`——订阅 token 这样发会 401。所以插件在 `session.hook("http.request")` 里接管整个 `Request`：

| 环节 | 处理 |
| --- | --- |
| 认证头 | 删掉 `x-api-key`，换成 `Authorization: Bearer <access>` |
| beta 标记 | 补齐 `oauth-2025-04-20`、`claude-code-20250219` 等 Claude Code 必带的 beta；按模型做增删 |
| 客户端指纹 | `user-agent: claude-cli/…`、`x-app: cli`、`x-stainless-*`、`X-Claude-Code-Session-Id` |
| system prompt | 第一块强制为 Claude Code 身份串；剥掉 opencode 品牌段落；补 `x-anthropic-billing-header` 校验串 |
| 工具名 | `glob` → `mcp_Glob`（Claude Code 用 PascalCase，小写裸名会被判定为第三方客户端），响应流里再还原 |
| URL | `/v1/messages` 补 `?beta=true` |

响应侧在 `session.hook("http.response")`：还原工具名；抓 `anthropic-ratelimit-unified-*` 头刷新限额快照；碰到 long-context / extra-usage 报错时记下惹事的 beta，下一次请求自动不带它。

限额快照落在 `~/.local/share/opencode/claude-oauth-usage.json`（原子写），TUI 侧插件每 4 秒读一次——两侧插件跑在不同进程里，没有共享通道，文件就是那道缝。

## 环境变量

都不用设，出问题时才需要。

| 变量 | 作用 |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude Code 配置目录，默认 `~/.claude` |
| `ANTHROPIC_CLI_VERSION` | 伪装的 Claude Code 版本，默认 `2.1.217` |
| `ANTHROPIC_USER_AGENT` | 整个 UA 串 |
| `ANTHROPIC_BETA_FLAGS` | 逗号分隔，完全覆盖默认 beta 列表 |
| `CLAUDE_OAUTH_SYSTEM_IDENTITY` | 第一块 system prompt 的身份串 |
| `CLAUDE_OAUTH_TOOL_PREFIX` | 设为 `0` 关掉工具名重写 |
| `CLAUDE_OAUTH_USAGE` | 设为 `0` 关掉限额侧边栏 |
| `CLAUDE_OAUTH_CLIENT_ID` / `CLAUDE_OAUTH_AUTHORIZE_URL` / `CLAUDE_OAUTH_TOKEN_URL` / `CLAUDE_OAUTH_REDIRECT_URI` | 上游端点变了时应急覆盖 |

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.ts` | 插件本体：注册 OAuth method、catalog 改写、两个 session hook |
| `src/config.ts` | 全部常量与环境变量覆盖 |
| `src/oauth.ts` | PKCE、授权 URL、code 交换、refresh |
| `src/claude-code.ts` | 读本机 Claude Code 凭据（Keychain / 文件） |
| `src/transform.ts` | 请求头、system prompt、billing 校验串、工具名前缀 |
| `src/stream.ts` | 响应流里还原工具名（按行缓冲，不会被分片切坏） |
| `src/usage.ts` | 限额窗口的解析、抓取与快照读写 |
| `tui.tsx` | 侧边栏本体，注册 `sidebar.content` slot |

## 开发

```bash
bun install
bunx tsc --noEmit
```

改完同步到安装目录再重启 opencode2。服务端插件不像 TUI 插件那样按 mtime 热重载。

加载失败会记在 `~/.local/share/opencode/log/`（Windows 在 `%LOCALAPPDATA%`）。

## 注意

Anthropic 的服务条款要求 Claude Pro / Max 的订阅 token 只在官方客户端使用。这是社区绕行方案，Anthropic 改动 OAuth 基础设施时随时可能失效。自行斟酌。

## License

MIT
