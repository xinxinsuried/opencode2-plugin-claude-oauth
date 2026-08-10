import { Credential, Integration, Plugin } from "@opencode-ai/plugin"
import { accounts, type ClaudeCodeAccount } from "./src/claude-code.ts"
import { INTEGRATION_ID, METHOD, PROVIDER_ID, usageEnabled } from "./src/config.ts"
import { authorization, exchange, refresh } from "./src/oauth.ts"
import { stripToolPrefix } from "./src/stream.ts"
import { applyHeaders, noteBetaRejection, rewriteBody } from "./src/transform.ts"
import { fetchUsage, fromHeaders, read as readUsage, USAGE_TTL, write as writeUsage } from "./src/usage.ts"

type Tokens = { access: string; refresh: string; expires: number }

function credential(methodID: string, tokens: Tokens, plan?: string): Credential.OAuth {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make(methodID),
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    ...(plan ? { metadata: { plan } } : {}),
  })
}

/**
 * `accounts()` hits the filesystem and, on macOS, shells out to `security`.
 * The integration draft is rebuilt often, so the account list is cached.
 */
const ACCOUNTS_TTL = 30_000
let cache: { at: number; value: ClaudeCodeAccount[] } | undefined

function cachedAccounts(): ClaudeCodeAccount[] {
  if (cache && Date.now() - cache.at < ACCOUNTS_TTL) return cache.value
  const value = accounts()
  cache = { at: Date.now(), value }
  return value
}

export default Plugin.define({
  id: "claude-oauth",
  setup: async (context) => {
    /**
     * opencode2 resolves an OAuth credential for `@ai-sdk/anthropic` into
     * `x-api-key`, which Anthropic rejects for subscription tokens. Tracking
     * whether the live connection is OAuth lets the request hook fix that up
     * while leaving plain API-key setups untouched.
     */
    const state = { oauth: false }
    const usage = usageEnabled(context.options)
    /** Aborts the event subscription and any in-flight usage fetch on dispose. */
    const watching = new AbortController()

    /**
     * Header capture only starts once a request has gone out, so the snapshot
     * is seeded from the REST endpoint too. `force` is for a fresh login,
     * where the cached numbers belong to the previous account.
     */
    const seedUsage = async (force: boolean) => {
      if (!usage) return
      const existing = readUsage()
      if (!force && existing && Date.now() - existing.fetchedAt < USAGE_TTL) return
      const credential = await sync()
      if (!credential) return
      const snapshot = await fetchUsage(credential.access, watching.signal).catch(() => undefined)
      if (snapshot) writeUsage(snapshot)
    }

    const sync = async () => {
      const connection = await context.integration.connection.active(INTEGRATION_ID)
      if (!connection) {
        state.oauth = false
        return undefined
      }
      const resolved = await context.integration.connection.resolve(connection).catch(() => undefined)
      state.oauth = resolved?.type === "oauth"
      return resolved?.type === "oauth" ? resolved : undefined
    }

    await sync()

    // Integrations are not necessarily registered by the time plugins set up,
    // so the first seed retries until the connection resolves. Bounded: a
    // logged-out user must not leave a timer running forever.
    void (async () => {
      for (const delay of [0, 3_000, 10_000, 30_000]) {
        if (watching.signal.aborted) return
        if (delay > 0) {
          const pause = Promise.withResolvers<void>()
          setTimeout(pause.resolve, delay)
          await pause.promise
        }
        await seedUsage(false).catch(() => {})
        if (readUsage()) return
      }
    })()

    // A login/logout has to force a catalog reload so the provider's model
    // catalog reflects the live credential state.
    void (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: watching.signal })) {
          if (event.type !== "integration.connection.updated") continue
          if (event.data.integrationID !== INTEGRATION_ID) continue
          await sync()
          void seedUsage(true)
          await context.catalog.reload()
        }
      } catch {
        // subscription closed with the plugin scope
      }
    })()

    const registrations = [
      await context.integration.transform((draft) => {
        draft.method.update({
          integrationID: INTEGRATION_ID,
          method: {
            id: Integration.MethodID.make(METHOD.max),
            type: "oauth",
            label: "Claude Pro/Max subscription",
          },
          authorize: async () => {
            const attempt = await authorization("max")
            return {
              mode: "code",
              url: attempt.url,
              instructions: "Approve access, then paste the code the page shows (it looks like `abc...#def...`).",
              callback: async (code: string) => credential(METHOD.max, await exchange(code, attempt)),
            }
          },
          refresh: async (current) => credential(METHOD.max, await refresh(current.refresh)),
          label: (current) => (typeof current.metadata?.plan === "string" ? current.metadata.plan : "Claude Pro/Max"),
        })

        const found = cachedAccounts()
        if (found.length === 0) return

        draft.method.update({
          integrationID: INTEGRATION_ID,
          method: {
            id: Integration.MethodID.make(METHOD.claudeCode),
            type: "oauth",
            label: "Reuse the Claude Code login on this machine",
            ...(found.length > 1
              ? {
                  prompts: [
                    {
                      type: "select" as const,
                      key: "account",
                      message: "Which Claude Code account?",
                      options: found.map((account) => ({ label: account.label, value: account.origin })),
                    },
                  ],
                }
              : {}),
          },
          authorize: async (inputs) => {
            const latest = accounts()
            const chosen = latest.find((account) => account.origin === inputs.account) ?? latest[0]
            if (!chosen) throw new Error("No Claude Code credentials found — run `claude` to log in first.")
            return {
              mode: "auto",
              url: "",
              instructions: `Imported ${chosen.label}`,
              callback: Promise.resolve(credential(METHOD.claudeCode, chosen, chosen.subscription)),
            }
          },
          refresh: async (current) => credential(METHOD.claudeCode, await refresh(current.refresh)),
          label: (current) =>
            typeof current.metadata?.plan === "string" ? `Claude ${current.metadata.plan}` : "Claude Code",
        })
      }),

      await context.session.hook("http.request", async (input) => {
        if (input.model.providerID !== PROVIDER_ID) return

        const request = input.request
        // Core puts the resolved credential in `x-api-key` regardless of its
        // type. A subscription token there is always wrong, so it is both the
        // trigger and — when the connection lookup fails transiently — the
        // fallback source for the bearer token.
        const carried = request.headers.get("x-api-key")
        const subscription = carried?.startsWith("sk-ant-oat") === true
        const access = (await sync())?.access ?? (subscription ? carried : undefined)
        if (!access) return

        const url = new URL(request.url)
        if (url.pathname.endsWith("/v1/messages") && !url.searchParams.has("beta")) {
          url.searchParams.set("beta", "true")
        }

        const headers = new Headers(request.headers)
        applyHeaders(headers, access, input.model.id)

        const raw = request.body ? await request.text() : undefined
        input.request = new Request(url, {
          method: request.method,
          headers,
          body: raw === undefined ? undefined : rewriteBody(raw),
        })
      }),

      await context.session.hook("http.response", async (input) => {
        if (input.model.providerID !== PROVIDER_ID) return
        if (!state.oauth && !input.request.headers.get("authorization")?.startsWith("Bearer sk-ant-oat")) return

        // Every /v1/messages reply carries the live 5h/7d windows, so the
        // sidebar stays current without spending a request of its own.
        if (usage) {
          const snapshot = fromHeaders(input.response.headers)
          if (snapshot) writeUsage(snapshot)
        }

        if (!input.response.ok) {
          const body = await input.response.clone().text().catch(() => "")
          // Retire the offending beta so the host's retry goes out clean.
          if (noteBetaRejection(input.model.id, body)) await context.catalog.reload()
          return
        }

        input.response = stripToolPrefix(input.response)
      }),
    ]

    return async () => {
      watching.abort()
      for (const registration of registrations) await registration.dispose()
    }
  },
})
