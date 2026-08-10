import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Service name Claude Code uses for its macOS Keychain entry. */
const KEYCHAIN_SERVICE = "Claude Code-credentials"

export type ClaudeCodeAccount = {
  access: string
  refresh: string
  expires: number
  subscription?: string
  /** Human label for the account picker. */
  label: string
  /** Where the credentials came from, e.g. `~/.claude/.credentials.json`. */
  origin: string
}

/**
 * Claude Code stores either `{claudeAiOauth: {...}}` (current) or the bare
 * credential object (older builds); accept both.
 */
function parse(raw: string, origin: string): ClaudeCodeAccount | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined

  const data = "claudeAiOauth" in parsed ? parsed.claudeAiOauth : parsed
  if (!data || typeof data !== "object") return undefined
  if (!("accessToken" in data && "refreshToken" in data && "expiresAt" in data)) return undefined

  const { accessToken, refreshToken, expiresAt } = data
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number") {
    return undefined
  }

  const subscription =
    "subscriptionType" in data && typeof data.subscriptionType === "string" ? data.subscriptionType : undefined

  return {
    access: accessToken,
    refresh: refreshToken,
    expires: Math.trunc(expiresAt),
    subscription,
    label: `${subscription ? `Claude ${subscription}` : "Claude Code"} — ${origin}`,
    origin,
  }
}

/**
 * Every Claude Code credential store readable on this machine. Keychain comes
 * first because that is what the CLI itself prefers on macOS.
 */
export function accounts(): ClaudeCodeAccount[] {
  const found: ClaudeCodeAccount[] = []

  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
        timeout: 5000,
        encoding: "utf-8",
      }).trim()
      const account = parse(raw, `macOS Keychain (${KEYCHAIN_SERVICE})`)
      if (account) found.push(account)
    } catch {
      // no keychain entry, or access denied — fall back to the file store
    }
  }

  const home = join(homedir(), ".claude")
  const configured = process.env.CLAUDE_CONFIG_DIR
  const dirs = configured && configured !== home ? [configured, home] : [home]

  for (const dir of dirs) {
    const path = join(dir, ".credentials.json")
    let raw: string
    try {
      raw = readFileSync(path, "utf-8")
    } catch {
      continue
    }
    const account = parse(raw, path)
    if (account && !found.some((existing) => existing.access === account.access)) found.push(account)
  }

  return found
}
