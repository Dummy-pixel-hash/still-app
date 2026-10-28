import type { AgentInputRequest, AgentPermissionRequest, AgentRequestKind, AgentRequestOutcome, AgentRequestSummary, AgentThreadEvent, AgentToolContent } from "./types"

export interface TranscriptItem {
  id: string
  kind: "user" | "assistant" | "reasoning" | "tool" | "notice" | "request"
  text: string
  title?: string
  status?: string
  content?: AgentToolContent[]
  toolKind?: string
  input?: Record<string, unknown>
  output?: unknown
  locations?: Array<{ path: string; line?: number }>
  messageId?: string
  checkpoint?: Record<string, unknown>
  requestId?: string | number
  requestKind?: AgentRequestKind
  request?: AgentRequestSummary
  permission?: AgentPermissionRequest
  agentInput?: AgentInputRequest
  requestOutcome?: AgentRequestOutcome
  attemptId?: string
}

/** Project ACP events into readable messages; protocol sequence remains untouched. */
export function conversation(events: AgentThreadEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let stream: TranscriptItem | undefined
  let messageId: string | undefined
  const tools = new Map<string, TranscriptItem>()
  const requests = new Map<string, TranscriptItem>()
  let attempt: string | undefined
  const requestKey = (kind: AgentRequestKind, id: string | number) => JSON.stringify([kind, id])
  const expireRequests = () => {
    for (const item of requests.values()) if (!item.requestOutcome) item.requestOutcome = {
      requestId: item.requestId!, kind: item.requestKind!, title: item.title || "Agent request", outcome: "uncertain",
    }
  }
  for (const event of events) {
    if (event.attemptId !== attempt) { attempt = event.attemptId; stream = undefined; tools.clear(); requests.clear() }
    const key = `${event.attemptId || "legacy"}:${event.sequence}`
    if (event.type === "userMessage") {
      stream = undefined
      tools.clear()
      items.push({ id: `user-${key}`, kind: "user", text: event.text || "", messageId: event.messageId, checkpoint: event.checkpoint })
    } else if (event.type === "assistantChunk" || event.type === "reasoningChunk") {
      const kind = event.type === "assistantChunk" ? "assistant" : "reasoning"
      if (!stream || stream.kind !== kind || event.messageId && event.messageId !== messageId) {
        messageId = event.messageId
        stream = { id: `${kind}-${key}`, kind, text: "" }
        items.push(stream)
      }
      stream.text += event.text || ""
    } else if (event.type === "assistantMessage") {
      if (stream?.kind === "assistant") stream.text = event.text || stream.text
      else items.push({ id: `assistant-${key}`, kind: "assistant", text: event.text || "" })
      stream = undefined
    } else if ((event.type === "toolStart" || event.type === "toolUpdate") && event.toolCallId) {
      stream = undefined
      let tool = tools.get(event.toolCallId)
      if (!tool) {
        tool = { id: `tool-${key}-${event.toolCallId}`, kind: "tool", text: "" }
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
      items.push({ id: `notice-${key}`, kind: "notice", text: event.text })
    } else if (event.type === "permission" && event.permission) {
      stream = undefined
      const request = event.permission
      const existing = requests.get(requestKey("permission", request.requestId))
      if (existing && !existing.requestOutcome) { existing.permission = request; continue }
      const item: TranscriptItem = { id: `request-permission-${key}-${String(request.requestId)}`, kind: "request", attemptId: event.attemptId, title: request.title, text: request.description || "", requestId: request.requestId, requestKind: "permission", permission: request }
      requests.set(requestKey("permission", request.requestId), item)
      items.push(item)
    } else if (event.type === "input" && event.input) {
      stream = undefined
      const request = event.input
      const existing = requests.get(requestKey("question", request.requestId))
      if (existing && !existing.requestOutcome) { existing.agentInput = request; continue }
      const item: TranscriptItem = { id: `request-question-${key}-${String(request.requestId)}`, kind: "request", attemptId: event.attemptId, title: request.title, text: "", requestId: request.requestId, requestKind: "question", agentInput: request }
      requests.set(requestKey("question", request.requestId), item)
      items.push(item)
    } else if (event.type === "agentRequest" && event.request) {
      stream = undefined
      const request = event.request
      const item: TranscriptItem = { id: `request-${request.kind}-${key}-${String(request.requestId)}`, kind: "request", attemptId: event.attemptId, title: request.title, text: "", requestId: request.requestId, requestKind: request.kind }
      requests.set(requestKey(request.kind, request.requestId), item)
      items.push(item)
    } else if (event.type === "requestOutcome" && event.requestOutcome) {
      const result = event.requestOutcome
      const item = requests.get(requestKey(result.kind, result.requestId))
      if (item) item.requestOutcome = result
      else items.push({ id: `request-result-${key}`, kind: "request", attemptId: event.attemptId, title: result.title, text: "", requestId: result.requestId, requestKind: result.kind, requestOutcome: result })
    } else if (event.type === "threadError") {
      stream = undefined
      expireRequests()
      if (event.text) items.push({ id: `error-${key}`, kind: "notice", status: "error", title: "Agent error", text: event.text })
    } else if (event.type === "threadComplete" || event.type === "threadStopped") {
      stream = undefined
      expireRequests()
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
