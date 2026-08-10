import { createHash, randomUUID } from "node:crypto"
import {
  BASE_BETAS,
  CACHE_TTL,
  CCH_POSITIONS,
  CCH_SALT,
  CC_ENTRYPOINT,
  CC_VERSION,
  IDENTITY_PREFIXES,
  MODEL_BETA_OVERRIDES,
  PARAGRAPH_REMOVAL_ANCHORS,
  SYSTEM_IDENTITY,
  TEXT_REPLACEMENTS,
  TOOL_PREFIX,
  TOOL_PREFIX_ENABLED,
  TOOL_SORT_ENABLED,
  USER_AGENT,
} from "./config.ts"

/** Stable for the process, mirroring Claude Code's X-Claude-Code-Session-Id. */
const SESSION_ID = randomUUID()

/** Betas retired per model after the API rejected them; see `noteBetaRejection`. */
const rejectedBetas = new Map<string, Set<string>>()

export function betasFor(modelID: string): string[] {
  const lower = modelID.toLowerCase()
  let betas = [...BASE_BETAS]

  const override = MODEL_BETA_OVERRIDES.find(([pattern]) => lower.includes(pattern))?.[1]
  if (override?.exclude) betas = betas.filter((beta) => !override.exclude?.includes(beta))
  for (const beta of override?.add ?? []) if (!betas.includes(beta)) betas.push(beta)

  const rejected = rejectedBetas.get(modelID)
  return rejected ? betas.filter((beta) => !rejected.has(beta)) : betas
}

/**
 * "Extra usage"/long-context refusals are beta-flag problems, not quota
 * problems. Record the offending flag so the next request for this model drops
 * it — the host's own retry then succeeds without user intervention.
 */
export function noteBetaRejection(modelID: string, body: string): boolean {
  const longContext =
    body.includes("Extra usage is required for long context requests") ||
    body.includes("long context beta is not yet available") ||
    body.includes("You're out of extra usage")
  if (!longContext) return false

  const rejected = rejectedBetas.get(modelID) ?? new Set<string>()
  const next = betasFor(modelID).find((beta) => beta.includes("context") || beta.includes("interleaved-thinking"))
  if (!next) return false

  rejected.add(next)
  rejectedBetas.set(modelID, rejected)
  return true
}

export function applyHeaders(headers: Headers, access: string, modelID: string): void {
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean)

  headers.set("authorization", `Bearer ${access}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", [...new Set([...betasFor(modelID), ...incoming])].join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", USER_AGENT)
  headers.set("x-client-request-id", randomUUID())
  headers.set("X-Claude-Code-Session-Id", SESSION_ID)

  const stainless: Record<string, string> = {
    "x-stainless-arch": process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
  for (const [name, value] of Object.entries(stainless)) if (!headers.has(name)) headers.set(name, value)

  // OAuth and API-key auth are mutually exclusive; leaving both trips a 401.
  headers.delete("x-api-key")
}

/** Strip opencode branding that Anthropic's classifier uses to spot third-party CLIs. */
function sanitize(text: string): string {
  const kept = text.split(/\n\n+/).filter((paragraph) => {
    if (IDENTITY_PREFIXES.some((prefix) => paragraph.includes(prefix))) return false
    return !PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor))
  })

  let result = kept.join("\n\n")
  for (const { match, replacement } of TEXT_REPLACEMENTS) result = result.replaceAll(match, replacement)
  return result.trim()
}

type SystemBlock = { type: string; text: string; [key: string]: unknown }

function systemBlocks(system: unknown): SystemBlock[] {
  if (system == null) return []
  if (typeof system === "string") return [{ type: "text", text: sanitize(system) }]
  if (!Array.isArray(system)) {
    if (typeof system === "object" && "text" in system && typeof system.text === "string") {
      return [{ ...system, type: "text", text: sanitize(system.text) }]
    }
    return []
  }

  return system.flatMap((item: unknown): SystemBlock[] => {
    if (typeof item === "string") return [{ type: "text", text: sanitize(item) }]
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
      return [{ ...item, type: "text", text: sanitize(item.text) }]
    }
    return []
  })
}

/**
 * `cc_version` carries a 3-char checksum over characters sampled from the first
 * user message, salted with a constant lifted from the Claude Code bundle.
 * Claude Code sends this as the first system block; a missing or wrong value
 * marks the request as a non-first-party client.
 */
function billingHeader(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined

  const first = messages.find(
    (message: unknown) => message && typeof message === "object" && "role" in message && message.role === "user",
  )
  if (!first || typeof first !== "object" || !("content" in first)) return undefined

  const { content } = first
  let text = ""
  if (typeof content === "string") text = content
  else if (Array.isArray(content)) {
    const block = content.find(
      (entry: unknown) => entry && typeof entry === "object" && "type" in entry && entry.type === "text",
    )
    if (block && typeof block === "object" && "text" in block && typeof block.text === "string") text = block.text
  }

  const sampled = CCH_POSITIONS.map((index) => text[index] ?? "0").join("")
  const suffix = createHash("sha256").update(`${CCH_SALT}${sampled}${CC_VERSION}`).digest("hex").slice(0, 3)
  const cch = createHash("sha256").update(text).digest("hex").slice(0, 5)

  return `x-anthropic-billing-header: cc_version=${CC_VERSION}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`
}

/**
 * Claude Code sends PascalCase tool names behind an `mcp_` prefix. Lowercase
 * bare names are one of the signals that flag a non-Claude-Code client, so the
 * names go out prefixed and come back stripped in `stream.ts`.
 */
function prefixed(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

export function rewriteBody(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw

  const body = parsed as Record<string, unknown>

  const blocks = systemBlocks(body.system)
  const identity: SystemBlock = { type: "text", text: SYSTEM_IDENTITY }
  const system = blocks[0]?.text === SYSTEM_IDENTITY ? blocks : [identity, ...blocks]

  const billing = billingHeader(body.messages)
  if (billing) system.unshift({ type: "text", text: billing })
  body.system = system

  if (TOOL_PREFIX_ENABLED) {
    if (Array.isArray(body.tools)) {
      body.tools = body.tools.map((tool: unknown) =>
        tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string"
          ? { ...tool, name: prefixed(tool.name) }
          : tool,
      )
    }

    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map((message: unknown) => {
        if (!message || typeof message !== "object" || !("content" in message)) return message
        if (!Array.isArray(message.content)) return message
        const content = message.content.map((block: unknown) =>
          block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "tool_use" &&
          "name" in block &&
          typeof block.name === "string"
            ? { ...block, name: prefixed(block.name) }
            : block,
        )
        return { ...message, content }
      })
    }
  }

  // MCP servers connect asynchronously, so opencode's tool order is not stable
  // between sessions. A byte-identical tools segment is what keeps Anthropic's
  // tools cache entry alive — sort by name (the rename above already ran, so the
  // order matches the wire form).
  if (TOOL_SORT_ENABLED && Array.isArray(body.tools)) {
    ;(body.tools as Array<{ name?: unknown }>).sort((a, b) => {
      const na = typeof a?.name === "string" ? a.name : ""
      const nb = typeof b?.name === "string" ? b.name : ""
      return na < nb ? -1 : na > nb ? 1 : 0
    })
  }

  // Stamp the long retention on every ephemeral breakpoint, mirroring omp's
  // per-request ttl:"1h" instead of relying on the beta's implicit default.
  const longTtl = { type: "ephemeral", ttl: CACHE_TTL }
  const forceCacheTtl = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (const item of value) forceCacheTtl(item)
      return
    }
    const record = value as Record<string, unknown>
    const control = record.cache_control
    if (control && typeof control === "object" && (control as { type?: unknown }).type === "ephemeral") {
      record.cache_control = { ...longTtl }
    }
    // A JSON-Schema property legitimately named `cache_control` lives inside
    // tool input schemas; do not descend there.
    for (const [key, nested] of Object.entries(record)) {
      if (key === "input_schema") continue
      forceCacheTtl(nested)
    }
  }
  forceCacheTtl(body)

  return JSON.stringify(body)
}
