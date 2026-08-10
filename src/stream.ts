import { TOOL_PREFIX_ENABLED } from "./config.ts"

const TOOL_NAME = /"name"\s*:\s*"mcp_([^"]+)"/g

function unprefix(text: string): string {
  return text.replace(TOOL_NAME, (_match, name: string) => `"name":"${name.charAt(0).toLowerCase()}${name.slice(1)}"`)
}

/**
 * Undo the `mcp_` tool renaming applied on the way out.
 *
 * Rewriting has to happen on complete lines: a chunk boundary can land inside
 * `"name":"mcp_Bash"` and a naive per-chunk replace would miss it. SSE frames
 * are newline-delimited and the JSON payload never contains a raw newline, so
 * buffering up to the last newline is both sufficient and bounded.
 */
export function stripToolPrefix(response: Response): Response {
  if (!TOOL_PREFIX_ENABLED || !response.body) return response

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""

  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const boundary = pending.lastIndexOf("\n")
        if (boundary === -1) return
        const complete = pending.slice(0, boundary + 1)
        pending = pending.slice(boundary + 1)
        controller.enqueue(encoder.encode(unprefix(complete)))
      },
      flush(controller) {
        pending += decoder.decode()
        if (pending) controller.enqueue(encoder.encode(unprefix(pending)))
      },
    }),
  )

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
