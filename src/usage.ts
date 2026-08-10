import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Where the server half drops the snapshot for the TUI half to render. Plugins
 * have no shared channel, so the filesystem is the seam.
 */
export const CACHE_PATH = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "opencode",
  "claude-oauth-usage.json",
)

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

/** How stale a snapshot may be before a seed refetches it. */
export const USAGE_TTL = 5 * 60_000

/** A single rate-limit window. `utilization` is a 0..1 fraction. */
export type Window = {
  utilization: number
  /** Epoch ms, or undefined when the window has no scheduled reset. */
  resetsAt?: number
  /** `allowed`, `allowed_warning`, `rejected`. */
  status?: string
}

export type Usage = {
  fetchedAt: number
  fiveHour?: Window
  sevenDay?: Window
  sevenDayOpus?: Window
}

/**
 * Every `/v1/messages` response carries the live windows, so normal traffic
 * keeps the snapshot fresh without spending a request.
 */
export function fromHeaders(headers: Headers): Usage | undefined {
  const read = (span: string): Window | undefined => {
    // `Number(null)` is 0, so an absent window would otherwise read as 0%.
    const raw = headers.get(`anthropic-ratelimit-unified-${span}-utilization`)
    if (raw === null) return undefined
    const utilization = Number(raw)
    if (!Number.isFinite(utilization)) return undefined
    const reset = Number(headers.get(`anthropic-ratelimit-unified-${span}-reset`))
    return {
      utilization,
      resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined,
      status: headers.get(`anthropic-ratelimit-unified-${span}-status`) ?? undefined,
    }
  }

  const fiveHour = read("5h")
  const sevenDay = read("7d")
  if (!fiveHour && !sevenDay) return undefined
  return { fetchedAt: Date.now(), fiveHour, sevenDay, sevenDayOpus: read("7d-opus") }
}

function window(value: unknown): Window | undefined {
  if (!value || typeof value !== "object") return undefined
  if (!("utilization" in value) || typeof value.utilization !== "number") return undefined
  const resetsAt =
    "resets_at" in value && typeof value.resets_at === "string" ? Date.parse(value.resets_at) : Number.NaN
  return {
    // The REST payload reports percentages; headers report fractions.
    utilization: value.utilization / 100,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
  }
}

/**
 * Authoritative read, used once at startup so the sidebar has numbers before
 * the first request of the session.
 */
export async function fetchUsage(access: string, signal?: AbortSignal): Promise<Usage | undefined> {
  const response = await fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20" },
    signal,
  })
  if (!response.ok) return undefined

  const payload: unknown = await response.json()
  if (!payload || typeof payload !== "object") return undefined

  const pick = (key: string) => (key in payload ? window((payload as Record<string, unknown>)[key]) : undefined)
  const fiveHour = pick("five_hour")
  const sevenDay = pick("seven_day")
  if (!fiveHour && !sevenDay) return undefined

  return { fetchedAt: Date.now(), fiveHour, sevenDay, sevenDayOpus: pick("seven_day_opus") }
}

/** Atomic so the TUI never reads a half-written file. */
export function write(usage: Usage): void {
  const temporary = `${CACHE_PATH}.${process.pid}.tmp`
  mkdirSync(dirname(CACHE_PATH), { recursive: true })
  writeFileSync(temporary, JSON.stringify(usage))
  renameSync(temporary, CACHE_PATH)
}

export function read(): Usage | undefined {
  let raw: string
  try {
    raw = readFileSync(CACHE_PATH, "utf-8")
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || !("fetchedAt" in parsed)) return undefined
  if (typeof parsed.fetchedAt !== "number") return undefined

  const at = (key: "fiveHour" | "sevenDay" | "sevenDayOpus"): Window | undefined => {
    if (!(key in parsed)) return undefined
    const value = (parsed as Record<string, unknown>)[key]
    if (!value || typeof value !== "object" || !("utilization" in value)) return undefined
    if (typeof value.utilization !== "number") return undefined
    const resetsAt = "resetsAt" in value && typeof value.resetsAt === "number" ? value.resetsAt : undefined
    const status = "status" in value && typeof value.status === "string" ? value.status : undefined
    return { utilization: value.utilization, resetsAt, status }
  }

  return {
    fetchedAt: parsed.fetchedAt,
    fiveHour: at("fiveHour"),
    sevenDay: at("sevenDay"),
    sevenDayOpus: at("sevenDayOpus"),
  }
}
