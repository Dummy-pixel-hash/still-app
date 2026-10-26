import type { AgentThreadEvent, AgentToolContent } from "./types"

export interface TranscriptItem {
  id: number
  kind: "user" | "assistant" | "reasoning" | "tool"
  text: string
  title?: string
  status?: string
  content?: AgentToolContent[]
}

/** Project ACP events into readable messages; protocol sequence remains untouched. */
export function conversation(events: AgentThreadEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let stream: TranscriptItem | undefined
  const tools = new Map<string, TranscriptItem>()
  for (const event of events) {
    if (event.type === "userMessage") {
      stream = undefined
      tools.clear()
      items.push({ id: event.sequence, kind: "user", text: event.text || "" })
    } else if (event.type === "assistantChunk" || event.type === "reasoningChunk") {
      const kind = event.type === "assistantChunk" ? "assistant" : "reasoning"
      if (!stream || stream.kind !== kind) {
        stream = { id: event.sequence, kind, text: "" }
        items.push(stream)
      }
      stream.text += event.text || ""
    } else if (event.type === "assistantMessage") {
      if (stream?.kind === "assistant") stream.text = event.text || stream.text
      else items.push({ id: event.sequence, kind: "assistant", text: event.text || "" })
      stream = undefined
    } else if ((event.type === "toolStart" || event.type === "toolUpdate") && event.toolCallId) {
      stream = undefined
      let tool = tools.get(event.toolCallId)
      if (!tool) {
        tool = { id: event.sequence, kind: "tool", text: "" }
        tools.set(event.toolCallId, tool)
        items.push(tool)
      }
      if (event.title) tool.title = event.title
      if (event.status) tool.status = event.status
      if (event.detail) tool.text = event.detail
      if (event.content) tool.content = event.content
    } else if (event.type === "threadComplete" || event.type === "threadError" || event.type === "permission") {
      stream = undefined
    }
  }
  return items
}
