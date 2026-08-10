/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { usageEnabled } from "./src/config.ts"
import { read, type Usage, type Window } from "./src/usage.ts"

/** The snapshot only moves when a request completes; a slow poll is plenty. */
const POLL_MS = 4000
const BAR_WIDTH = 10

/** Above this the window is close enough to matter; above 0.9 it is urgent. */
const WARN = 0.75
const DANGER = 0.9

type Row = {
  key: string
  label: string
  window: Window
  last: boolean
}

function bar(utilization: number): string {
  const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round(utilization * BAR_WIDTH)))
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled)
}

/** `2h13m` / `3d4h` — whichever two units carry the most information. */
function until(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return ""
  const seconds = Math.max(0, Math.round((resetsAt - now) / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${minutes}m`
  return `${minutes}m`
}

function View(props: { context: Plugin.Context }) {
  const theme = props.context.theme

  const [usage, setUsage] = createSignal<Usage | undefined>(read())
  const [now, setNow] = createSignal(Date.now())

  const timer = setInterval(() => {
    setUsage(read())
    setNow(Date.now())
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))

  const rows = (): Row[] => {
    const current = usage()
    if (!current) return []
    const entries: Array<[string, string, Window | undefined]> = [
      ["5h", "5h", current.fiveHour],
      ["7d", "7d", current.sevenDay],
      ["opus", "opus", current.sevenDayOpus],
    ]
    const present = entries.filter((entry): entry is [string, string, Window] => entry[2] !== undefined)
    return present.map(([key, label, window], index) => ({
      key,
      label,
      window,
      last: index === present.length - 1,
    }))
  }

  const colorFor = (window: Window) => {
    if (window.status === "rejected" || window.utilization >= DANGER) return theme.text.feedback.error.default
    if (window.utilization >= WARN) return theme.text.feedback.warning.default
    return theme.text.default
  }

  return (
    <box flexDirection="column">
      <text fg={theme.text.default}>
        <b>Claude limits</b>
      </text>
      <Show when={rows().length > 0} fallback={<text fg={theme.text.subdued}>No usage data yet</text>}>
        <For each={rows()}>
          {(row) => (
            <text fg={theme.text.subdued}>
              {row.last ? "└─ " : "├─ "}
              <span style={{ fg: theme.text.default }}>{row.label.padEnd(4)}</span>
              <span style={{ fg: colorFor(row.window) }}>{bar(row.window.utilization)}</span>
              {"  "}
              <span style={{ fg: colorFor(row.window) }}>
                {`${Math.round(row.window.utilization * 100)}%`.padStart(4)}
              </span>
              <span style={{ fg: theme.text.subdued }}>
                {row.window.resetsAt === undefined ? "" : `  ${until(row.window.resetsAt, now())}`}
              </span>
            </text>
          )}
        </For>
      </Show>
    </box>
  )
}

const plugin: Plugin.Definition = {
  id: "claude-oauth-usage",
  setup(context) {
    if (!usageEnabled(context.options)) return
    context.ui.slot("sidebar.content", () => <View context={context} />)
  },
}

export default plugin
