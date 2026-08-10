import { AUTHORIZE_URL, CLIENT_ID, REDIRECT_URI, SCOPES, TOKEN_URL, CREATE_API_KEY_URL } from "./config.ts"

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export type Pkce = { verifier: string; challenge: string }

export async function pkce(): Promise<Pkce> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

export type Authorization = {
  url: string
  verifier: string
  state: string
}

export async function authorization(mode: "max" | "console"): Promise<Authorization> {
  const { verifier, challenge } = await pkce()
  const state = crypto.randomUUID().replaceAll("-", "")

  const url = new URL(AUTHORIZE_URL[mode])
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", SCOPES.join(" "))
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)

  return { url: url.toString(), verifier, state }
}

/**
 * Accept every shape a user can realistically paste back: the whole callback
 * URL, the `code#state` fragment the console page renders, or a raw query
 * string.
 */
export function parseCallback(input: string): { code: string; state: string } | undefined {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (code && state) return { code, state }
  } catch {
    // not a URL — fall through
  }

  const [code, state] = trimmed.split("#")
  if (code && state) return { code, state }

  const params = new URLSearchParams(trimmed)
  const queryCode = params.get("code")
  const queryState = params.get("state")
  if (queryCode && queryState) return { code: queryCode, state: queryState }

  return undefined
}

export type Tokens = { access: string; refresh: string; expires: number }

const TOKEN_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  "User-Agent": "axios/1.13.6",
}

async function token(body: Record<string, string>): Promise<Tokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Anthropic OAuth ${body.grant_type} failed: ${response.status} ${detail.slice(0, 400)}`)
  }

  const json = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  if (!json.access_token) throw new Error("Anthropic OAuth response is missing access_token")

  return {
    access: json.access_token,
    refresh: json.refresh_token ?? "",
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
  }
}

export async function exchange(input: string, auth: Authorization): Promise<Tokens> {
  const callback = parseCallback(input)
  if (!callback) throw new Error("Could not read an authorization code out of that input")
  if (callback.state !== auth.state) throw new Error("OAuth state mismatch — restart the login")

  return token({
    grant_type: "authorization_code",
    code: callback.code,
    state: callback.state,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: auth.verifier,
  })
}

export async function refresh(refreshToken: string): Promise<Tokens> {
  const tokens = await token({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })
  // Anthropic rotates refresh tokens, but tolerate a response that omits one.
  return { ...tokens, refresh: tokens.refresh || refreshToken }
}

export async function createApiKey(access: string): Promise<string> {
  const response = await fetch(CREATE_API_KEY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${access}` },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Creating an API key failed: ${response.status} ${detail.slice(0, 400)}`)
  }
  const json = (await response.json()) as { raw_key?: string }
  if (!json.raw_key) throw new Error("API key response is missing raw_key")
  return json.raw_key
}
