import type { AgentThreadEvent, AgentToolContent } from "./types"

export interface TranscriptItem {
  id: string
  kind: "user" | "assistant" | "reasoning" | "tool" | "notice"
  text: string
  title?: string
  status?: string
  content?: AgentToolContent[]
  toolKind?: string
  input?: Record<string, unknown>
  output?: unknown
  locations?: Array<{ path: string; line?: number }>
}

/** Project ACP events into readable messages; protocol sequence remains untouched. */
export function conversation(events: AgentThreadEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let stream: TranscriptItem | undefined
  let turn = 0
  let messageId: string | undefined
  const tools = new Map<string, TranscriptItem>()
  for (const event of events) {
    if (event.type === "userMessage") {
      stream = undefined
      turn++
      tools.clear()
      items.push({ id: `user-${turn}`, kind: "user", text: event.text || "" })
    } else if (event.type === "assistantChunk" || event.type === "reasoningChunk") {
      const kind = event.type === "assistantChunk" ? "assistant" : "reasoning"
      if (!stream || stream.kind !== kind || event.messageId && event.messageId !== messageId) {
        messageId = event.messageId
        stream = { id: `${kind}-${turn}-${items.length}`, kind, text: "" }
        items.push(stream)
      }
      stream.text += event.text || ""
    } else if (event.type === "assistantMessage") {
      if (stream?.kind === "assistant") stream.text = event.text || stream.text
      else items.push({ id: `assistant-${turn}-${items.length}`, kind: "assistant", text: event.text || "" })
      stream = undefined
    } else if ((event.type === "toolStart" || event.type === "toolUpdate") && event.toolCallId) {
      stream = undefined
      let tool = tools.get(event.toolCallId)
      if (!tool) {
        tool = { id: `tool-${turn}-${event.toolCallId}`, kind: "tool", text: "" }
        tools.set(event.toolCallId, tool)
        items.push(tool)
      }
      if (event.title) tool.title = event.title
      if (event.status) tool.status = event.status
      if (event.detail) tool.text = event.detail
      if (event.content) tool.content = event.content
      if (event.rawInput) tool.input = event.rawInput
      if (event.rawOutput !== undefined) tool.output = event.rawOutput
      if (event.locations) tool.locations = event.locations
      if (event.toolKind) tool.toolKind = event.toolKind
      if (event.outputDelta) tool.text += event.outputDelta
    } else if (event.type === "notice" && event.text) {
      items.push({ id: `notice-${turn}-${items.length}`, kind: "notice", text: event.text })
    } else if (event.type === "threadComplete" || event.type === "threadError" || event.type === "permission") {
      stream = undefined
    }
  }
  return items
}

export function toolLabel(item: TranscriptItem) {
  const input = item.input || {}
  const path = String(input.path || input.file_path || input.filePath || item.locations?.[0]?.path || "")
  const command = typeof input.command === "string" ? input.command : ""
  const kind = item.toolKind || (/read/i.test(item.title || "") ? "read" : /bash|shell/i.test(item.title || "") ? "execute" : /edit|write|patch/i.test(item.title || "") ? "edit" : "other")
  if (kind === "read" && path) return { action: "Read", detail: path, kind }
  if (kind === "edit" && path) return { action: "Edit", detail: path, kind }
  if (kind === "search") return { action: "Search", detail: String(input.pattern || input.query || path || item.title || ""), kind }
  if (command) return { action: "Run", detail: command, kind: "execute" }
  return { action: item.title || "Tool call", detail: "", kind }
}
