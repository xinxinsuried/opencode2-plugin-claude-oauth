import { Credential, Integration, Plugin } from "@opencode-ai/plugin"
import { accounts, type ClaudeCodeAccount } from "./src/claude-code.ts"
import { INTEGRATION_ID, METHOD, PROVIDER_ID } from "./src/config.ts"
import { authorization, exchange, refresh } from "./src/oauth.ts"
import { stripToolPrefix } from "./src/stream.ts"
import { applyHeaders, noteBetaRejection, rewriteBody } from "./src/transform.ts"

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

    // The catalog is rebuilt from a snapshot of `state`, so a login/logout has
    // to force a reload for the cost overrides below to take effect.
    const watching = new AbortController()
    void (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: watching.signal })) {
          if (event.type !== "integration.connection.updated") continue
          if (event.data.integrationID !== INTEGRATION_ID) continue
          await sync()
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

      await context.catalog.transform((draft) => {
        if (!state.oauth) return
        const record = draft.provider.get(PROVIDER_ID)
        if (!record) return
        // Subscription usage is not metered per token; a priced catalog would
        // report fictional spend for every session.
        for (const id of record.models.keys()) draft.model.update(PROVIDER_ID, id, (model) => (model.cost = []))
      }),

      await context.session.hook("http.request", async (input) => {
        if (input.model.providerID !== PROVIDER_ID) return
        const resolved = await sync()
        if (!resolved) return

        const request = input.request
        const url = new URL(request.url)
        if (url.pathname.endsWith("/v1/messages") && !url.searchParams.has("beta")) {
          url.searchParams.set("beta", "true")
        }

        const headers = new Headers(request.headers)
        applyHeaders(headers, resolved.access, input.model.id)

        const raw = request.body ? await request.text() : undefined
        input.request = new Request(url, {
          method: request.method,
          headers,
          body: raw === undefined ? undefined : rewriteBody(raw),
        })
      }),

      await context.session.hook("http.response", async (input) => {
        if (input.model.providerID !== PROVIDER_ID || !state.oauth) return

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
