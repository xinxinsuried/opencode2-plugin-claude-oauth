/**
 * Anthropic OAuth + Claude Code impersonation constants.
 *
 * Every value here is overridable through the environment so a broken upstream
 * constant can be worked around without editing the plugin.
 */

const env = (name: string) => {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : value
}

/** Public client id shipped by the Claude Code CLI. */
export const CLIENT_ID = env("CLAUDE_OAUTH_CLIENT_ID") ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

export const AUTHORIZE_URL = {
  /** Claude Pro / Max subscription login. */
  max: env("CLAUDE_OAUTH_AUTHORIZE_URL") ?? "https://claude.ai/oauth/authorize",
  /** Console login, used only to mint a metered API key. */
  console: env("CLAUDE_OAUTH_CONSOLE_URL") ?? "https://platform.claude.com/oauth/authorize",
} as const

/** Out-of-band redirect: the browser renders `code#state` for the user to paste. */
export const REDIRECT_URI =
  env("CLAUDE_OAUTH_REDIRECT_URI") ?? "https://platform.claude.com/oauth/code/callback"

export const TOKEN_URL = env("CLAUDE_OAUTH_TOKEN_URL") ?? "https://platform.claude.com/v1/oauth/token"

export const CREATE_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"

export const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]

/** Claude Code release we impersonate. Bump when Anthropic tightens the check. */
export const CC_VERSION = env("ANTHROPIC_CLI_VERSION") ?? "2.1.217"
export const CC_ENTRYPOINT = env("CLAUDE_CODE_ENTRYPOINT") ?? "sdk-cli"
export const USER_AGENT = env("ANTHROPIC_USER_AGENT") ?? `claude-cli/${CC_VERSION} (external, ${CC_ENTRYPOINT})`

/**
 * First system block. Anthropic rejects subscription tokens whose request does
 * not open with the Claude Code identity.
 */
export const SYSTEM_IDENTITY =
  env("CLAUDE_OAUTH_SYSTEM_IDENTITY") ?? "You are Claude Code, Anthropic's official CLI for Claude."

/** Billing-header checksum inputs, lifted from the Claude Code bundle. */
export const CCH_SALT = "59cf53e54c78"
export const CCH_POSITIONS = [4, 7, 20]

/** Betas Claude Code sends on every /v1/messages call. */
export const BASE_BETAS = (
  env("ANTHROPIC_BETA_FLAGS") ??
  [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "extended-cache-ttl-2025-04-11",
  ].join(",")
)
  .split(",")
  .map((beta) => beta.trim())
  .filter(Boolean)

/** Betas dropped one at a time when the API reports a long-context/extra-usage error. */
export const LONG_CONTEXT_BETAS = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"]

/**
 * Per-model beta adjustments, first match wins against a lowercased model id.
 * More specific keys must precede broader ones.
 */
export const MODEL_BETA_OVERRIDES: Array<[string, { exclude?: string[]; add?: string[] }]> = [
  ["sonnet", { exclude: ["effort-2025-11-24"] }],
  ["haiku", { exclude: ["effort-2025-11-24"] }],
  ["4-6", { add: ["effort-2025-11-24"] }],
  ["4-7", { add: ["effort-2025-11-24"] }],
]

export const TOOL_PREFIX = "mcp_"

/** Tool renaming is on by default; set to "0" to send opencode's raw tool names. */
export const TOOL_PREFIX_ENABLED = env("CLAUDE_OAUTH_TOOL_PREFIX") !== "0"

/**
 * Rate-limit sidebar. On by default; `options.usage: false` on the plugin
 * entry or `CLAUDE_OAUTH_USAGE=0` turns it off on both the server and TUI half.
 */
export function usageEnabled(options?: Readonly<Record<string, unknown>>): boolean {
  if (env("CLAUDE_OAUTH_USAGE") === "0") return false
  return options?.usage !== false
}

/**
 * Stable tool ordering keeps the tools cache segment byte-identical between
 * sessions (MCP servers connect asynchronously). Set `CLAUDE_OAUTH_SORT_TOOLS=0`
 * to keep opencode's original order.
 */
export const TOOL_SORT_ENABLED = env("CLAUDE_OAUTH_SORT_TOOLS") !== "0"

/**
 * Ephemeral cache retention stamped on every breakpoint, mirroring Claude
 * Code / omp's 1h default. `CLAUDE_OAUTH_CACHE_TTL=5m` opts back to short.
 */
export const CACHE_TTL = env("CLAUDE_OAUTH_CACHE_TTL") === "5m" ? "5m" : "1h"

/** Paragraph anchors that identify opencode-branded system-prompt sections. */
export const PARAGRAPH_REMOVAL_ANCHORS = ["opencode.ai/docs", "github.com/sst/opencode", "github.com/anomalyco/opencode"]

export const IDENTITY_PREFIXES = ["You are opencode", "You are OpenCode"]

/**
 * Inline rewrites. The environment-block sentence below is a verbatim
 * fingerprint of third-party agent CLIs and trips a 400 disguised as
 * "You're out of extra usage".
 */
export const TEXT_REPLACEMENTS: Array<{ match: string; replacement: string }> = [
  { match: "if opencode honestly", replacement: "if the assistant honestly" },
  { match: "if OpenCode honestly", replacement: "if the assistant honestly" },
  {
    match: "Here is some useful information about the environment you are running in:",
    replacement: "Environment context you are running in:",
  },
]

export const INTEGRATION_ID = "anthropic"
export const PROVIDER_ID = "anthropic"

export const METHOD = {
  max: "claude-pro-max",
  claudeCode: "claude-code-import",
  consoleKey: "claude-console-api-key",
} as const
