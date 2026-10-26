// Deterministic subprocess fixture for the real native driver transport.
import { createServer } from "node:http"
import { frameReader } from "../src-tauri/agent-host/bridge.mjs"

const type = process.env.STILL_TEST_PEER
const write = frame => process.stdout.write(JSON.stringify(frame) + "\n")
let prompts = 0
function respond(frame, data) {
  write(type === "pi" ? { id: frame.id, type: "response", command: frame.type, success: true, data }
    : type === "claude" ? { type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: data } }
      : { jsonrpc: "2.0", id: frame.id, result: data })
}
const toolInput = { command: "npm test", path: "/workspace/src/main.ts" }
let permissionId
let running = false
function turn() {
  if (type === "pi") {
    write({ type: "message_start", message: { role: "assistant" } })
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " } })
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" } })
    write({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: toolInput })
    write({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "running" }] } })
    write({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "passed" }], details: { exitCode: 0 } }, isError: false })
    write({ type: "agent_settled", aborted: false })
  } else if (type === "claude") {
    write({ type: "stream_event", event: { type: "message_start" } })
    write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello world" } } })
    write({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Bash", input: toolInput }] } })
    permissionId = `approval-${prompts}`
    write({ type: "control_request", request_id: permissionId, request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "call-1", input: toolInput } })
  } else if (type === "codex") {
    write({ method: "turn/started", params: { threadId: "thread-fixture", turn: { id: "turn-fixture" } } })
    write({ method: "item/agentMessage/delta", params: { threadId: "thread-fixture", itemId: "message-fixture", delta: "Hello world" } })
    write({ method: "item/started", params: { threadId: "thread-fixture", item: { id: "call-1", type: "commandExecution", command: "npm test", status: "inProgress" } } })
    permissionId = 700 + prompts
    write({ id: permissionId, method: "item/commandExecution/requestApproval", params: { threadId: "thread-fixture", itemId: "call-1", command: "npm test" } })
  }
}
function endTurn(accepted) {
  running = false
  if (type === "claude") {
    write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: accepted ? "passed" : "rejected", is_error: !accepted }] } })
    write({ type: "result", subtype: "success", is_error: false })
  } else {
    write({ method: "item/completed", params: { threadId: "thread-fixture", item: { id: "call-1", type: "commandExecution", command: "npm test", status: accepted ? "completed" : "failed", aggregatedOutput: accepted ? "passed" : "rejected", exitCode: accepted ? 0 : 1 } } })
    write({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "completed" } } })
  }
}
if (type === "opencode") {
  let streams = []
  let sessionModel = { providerID: "fixture", id: "model-a" }
  let scanned = false
  const event = value => streams.forEach(stream => stream.write(`data: ${JSON.stringify({ ...value, location: { directory: process.cwd() } })}\n\n`))
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    if (!req.headers.authorization) { res.writeHead(401).end(); return }
    if (url.pathname === "/api/event") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); streams.push(res); req.on("close", () => streams = streams.filter(stream => stream !== res)); return }
    let body = ""; for await (const chunk of req) body += chunk
    const input = body ? JSON.parse(body) : {}
    const send = value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)) }
    if (url.pathname === "/api/info") return send({ version: "2.0.0" })
    if (url.pathname === "/api/session/active") return send({ data: running ? { "session-fixture": { type: "running" } } : {} })
    if (url.pathname === "/api/session") return send({ data: { id: "session-fixture", agent: "build", model: sessionModel } })
    if (url.pathname === "/api/session/session-fixture" && req.method === "GET") return send({ data: { id: "session-fixture", agent: "build", model: sessionModel } })
    if (url.pathname === "/api/command") {
      if (!scanned) {
        setTimeout(() => { scanned = true; event({ type: "command.updated", data: {} }); event({ type: "skill.updated", data: {} }) }, 20)
        return send({ data: [] })
      }
      return send({ data: Array.from({ length: 24 }, (_, i) => ({ name: `team/command-${i}`, description: `Command ${i}` })) })
    }
    if (url.pathname === "/api/skill") return send({ data: [] })
    if (url.pathname === "/api/model") return send({ data: [{ id: "model-a", providerID: "fixture", name: "Model A", enabled: true, variants: [] }, { id: "model-b", providerID: "fixture", name: "Model B", enabled: true, variants: [] }] })
    if (url.pathname === "/api/agent") return send({ data: scanned ? [{ id: "build", name: "Build", mode: "primary" }] : [] })
    if (url.pathname.endsWith("/model")) { sessionModel = input.model; res.writeHead(204).end(); return }
    if (url.pathname.endsWith("/prompt")) {
      running = true
      send({ data: {} }); event({ type: "session.text.delta", data: { sessionID: "session-fixture", assistantMessageID: "msg-1", ordinal: 0, delta: "Hello world" } })
      if (input.text === "WAIT") event({ type: "session.text.delta", data: { sessionID: "session-fixture", assistantMessageID: "wait", ordinal: 0, delta: "WAIT_ADMITTED" } })
      else { running = false; event({ type: "session.execution.succeeded", data: { sessionID: "session-fixture" } }) }
      return
    }
    if (url.pathname.endsWith("/command")) {
      send({ data: {} }); event({ type: "session.text.delta", data: { sessionID: "session-fixture", messageID: "msg-2", index: 0, delta: `${input.name}: ${input.text}` } }); event({ type: "session.execution.succeeded", data: { sessionID: "session-fixture" } }); return
    }
    if (url.pathname.endsWith("/compact")) { send({ data: {} }); event({ type: "session.compaction.ended", data: { sessionID: "session-fixture" } }); return }
    if (url.pathname.endsWith("/interrupt")) { running = false; send({ interrupted: true }); event({ type: "session.execution.interrupted", data: { sessionID: "session-fixture" } }); return }
    res.writeHead(404).end()
  })
  server.listen(0, "127.0.0.1", () => console.log(`server listening on http://127.0.0.1:${server.address().port}`))
} else {
  process.stdin.on("data", frameReader(frame => {
    const method = frame.type === "control_request" ? frame.request.subtype : frame.type || frame.method
    if (frame.type === "control_response" && frame.response.request_id === permissionId) { endTurn(frame.response.response.behavior === "allow"); return }
    if (frame.id === permissionId && "result" in frame) { endTurn(frame.result.decision === "accept"); return }
    if (type === "pi") {
      if (method === "get_state") respond(frame, { sessionId: "pi-fixture", sessionFile: "/tmp/pi-fixture.jsonl", isStreaming: false, thinkingLevel: "medium", model: { id: "model-a", provider: "fixture" } })
      else if (method === "get_available_models") respond(frame, { models: [{ id: "model-a", provider: "fixture", name: "Model A" }] })
      else if (method === "get_commands") respond(frame, { commands: [{ name: "review", description: "Review code" }] })
      else if (method === "get_available_thinking_levels") respond(frame, { levels: ["off", "medium", "high"] })
      else if (method === "prompt") { prompts++; running = true; respond(frame, { disposition: "started" }); if (frame.message !== "WAIT") { turn(); running = false } else write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "WAIT_ADMITTED" } }) }
      else if (method === "abort") { running = false; respond(frame, {}); write({ type: "agent_settled", aborted: true }) }
      else respond(frame, {})
    } else if (type === "claude") {
      if (method === "initialize") respond(frame, { models: [{ value: "model-a", displayName: "Model A" }], commands: [{ name: "review", description: "Review code" }] })
      else if (frame.type === "user") { prompts++; running = true; if (frame.message.content[0]?.text !== "WAIT") turn(); else write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "WAIT_ADMITTED" } } }) }
      else if (method === "interrupt") { running = false; respond(frame, {}); write({ type: "result", subtype: "success", is_error: false }) }
      else respond(frame, {})
    } else if (type === "codex") {
      if (method === "initialize") respond(frame, { userAgent: "codex-fixture" })
      else if (method === "account/read") respond(frame, { requiresOpenaiAuth: false })
      else if (method === "thread/start" || method === "thread/resume") respond(frame, { thread: { id: "thread-fixture" }, model: "model-a", reasoningEffort: "medium" })
      else if (method === "model/list") respond(frame, { data: [{ id: "model-a", displayName: "Model A", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }], nextCursor: null })
      else if (method === "turn/start") { prompts++; running = true; respond(frame, { turn: { id: "turn-fixture" } }); if (frame.params.input[0]?.text !== "WAIT") turn(); else write({ method: "item/agentMessage/delta", params: { threadId: "thread-fixture", itemId: "wait", delta: "WAIT_ADMITTED" } }) }
      else if (method === "turn/interrupt") { running = false; respond(frame, {}); write({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "interrupted" } } }) }
      else if (method === "thread/compact/start") { respond(frame, {}); write({ method: "item/completed", params: { threadId: "thread-fixture", item: { id: "compact-fixture", type: "contextCompaction" } } }) }
      else if (method === "review/start") { prompts++; respond(frame, { turn: { id: "turn-fixture" } }); turn() }
      else if (method !== "initialized") respond(frame, {})
    }
  }, error => { console.error(error); process.exitCode = 1 }))
}
