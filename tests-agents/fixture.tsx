import React from "react"
import { createRoot } from "react-dom/client"
import "../src/styles/theme.css"
import AgentWorkspace from "../src/components/AgentWorkspace"
import { AGENTS, type AgentThreadEvent, type AgentThreadSnapshot } from "../src/agents/types"
import { registerNativeBridge } from "../src/bridge/nativeBridge"
import { mockBridge } from "../src/bridge/mockBridge"
import { startRemoteAgent } from "../src/session/agentThreads"

// This bridge is installed only by this test entrypoint, never by production code.
const snapshots = new Map<string, AgentThreadSnapshot>()
const sinks = new Map<string, (event: AgentThreadEvent) => void>()
let counter = 0
const h = {
  checks: [] as unknown[], starts: [] as unknown[], sends: [] as string[], configs: [] as unknown[], approvals: [] as unknown[],
  rejectConfig: false, rejectSend: false, closed: false,
  emit(id: string, event: Omit<AgentThreadEvent, "sequence">) {
    const row = snapshots.get(id)!
    const value = { ...event, sequence: ++row.lastSequence }
    row.transcript.push(value)
    if (event.type === "userMessage") { row.turnActive = true; row.state = "working" }
    if (event.type === "threadComplete") { row.turnActive = false; row.state = "working"; row.pendingPermission = undefined }
    if (event.type === "permission") { row.pendingPermission = event.permission; row.state = "inputRequired" }
    sinks.get(id)?.(structuredClone(value))
  },
  get current() { return [...snapshots.keys()].at(-1)! },
  finish() { h.emit(h.current, { type: "threadComplete", state: "working" }) },
  approval() { h.emit(h.current, { type: "permission", permission: { requestId: 91, sessionId: "acp-fixture", toolCallId: "shell", title: "Run the test suite", command: "npm test", options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } }) },
  populate() {
    const id = h.current
    h.emit(id, { type: "userMessage", text: "Review the SSH reconnect flow" })
    h.emit(id, { type: "assistantChunk", text: "## Reconnect behavior\n\nI found **one race** in the " })
    h.emit(id, { type: "assistantChunk", text: "session owner. The remote tmux session is preserved.\n\n" })
    h.emit(id, { type: "assistantChunk", text: "```ts\nawait reconnect(session.id)\n```\n\n- Keep the verified host key\n- Reuse the existing tmux session" })
    h.emit(id, { type: "toolStart", toolCallId: "read", title: "Read src/session/connections.ts", status: "in_progress" })
    h.emit(id, { type: "toolUpdate", toolCallId: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "export async function reconnect(id: string) {\n  return connectSession(id)\n}" } }] })
    h.emit(id, { type: "toolStart", toolCallId: "edit", title: "Update reconnect guard", status: "completed", content: [{ type: "diff", path: "src/session/connections.ts", oldText: "connectSession(id)", newText: "await connectSession(id)" }] })
    h.emit(id, { type: "plan", plan: [{ content: "Inspect the reconnect owner", status: "completed" }, { content: "Protect the current session", status: "in_progress" }, { content: "Verify reattachment", status: "pending" }] })
    h.emit(id, { type: "commands", commands: [{ name: "review", description: "Review the current changes" }, { name: "compact", description: "Compact this conversation" }] })
    h.finish()
  },
}
Object.assign(window, { agentFixture: h })
registerNativeBridge({
  ...mockBridge,
  agentCheck: async (_native, agentId, executable) => {
    h.checks.push({ agentId, executable })
    return (agentId ? AGENTS.filter(a => a.id === agentId) : AGENTS).map(a => ({ agentId: a.id, available: a.id !== "claude", executable: executable || `/home/dev/.local/bin/${a.executable}` }))
  },
  agentStart: async (_native, localId, agentId, options) => {
    h.starts.push({ agentId, options })
    const row: AgentThreadSnapshot = { executionId: `fixture-${++counter}`, localSessionId: localId, agentId, agentName: AGENTS.find(a => a.id === agentId)!.label, agentSessionId: "acp-fixture", cwd: options?.cwd || "/srv/still", state: "working", lastSequence: 0, transcript: [], turnActive: false,
      configOptions: [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "Model A" }, { name: "Other", options: [{ value: "b", name: "Model B" }] }] },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code" }] },
        { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
      ] }
    snapshots.set(row.executionId, row)
    return structuredClone(row)
  },
  agentSnapshot: async id => structuredClone(snapshots.get(id)!),
  subscribeToAgent: async (id, callback) => { sinks.set(id, callback); return () => { sinks.delete(id) } },
  agentSend: async (id, message) => {
    if (h.rejectSend) throw new Error("SSH disconnected. Submission is uncertain.")
    h.sends.push(message)
    h.emit(id, { type: "userMessage", text: message })
    h.emit(id, { type: "assistantChunk", text: "First " }); h.emit(id, { type: "assistantChunk", text: "second " }); h.emit(id, { type: "assistantChunk", text: "third." })
  },
  agentSetConfig: async (id, configId, value) => {
    if (h.rejectConfig) throw new Error("The agent rejected that setting.")
    h.configs.push({ configId, value })
    const row = snapshots.get(id)!
    row.configOptions.find(option => option.id === configId)!.currentValue = value
    h.emit(id, { type: "configOptions", configOptions: structuredClone(row.configOptions) })
  },
  agentRespondPermission: async (id, requestId, optionId) => {
    h.approvals.push({ requestId, optionId }); snapshots.get(id)!.pendingPermission = undefined
    h.emit(id, { type: "threadState", state: "working" })
  },
  agentCancel: async id => { h.emit(id, { type: "threadStopped", text: "Cancellation requested" }); h.finish() },
})

const session = { id: "agent-fixture", name: "Development", host: "dev.example.test", port: 22, username: "dev", projectId: "still", workingDirectory: "/srv/still", authMethod: "ask" as const, remember: false, tmuxSession: "still-dev", createdAt: 0, updatedAt: 0 }
createRoot(document.getElementById("root")!).render(<React.StrictMode><AgentWorkspace session={session} onClose={() => { h.closed = true }} onStart={(id, options) => startRemoteAgent("ssh-fixture", session.id, id, options)} onCheck={(id, path) => mockCheck(id, path)} /></React.StrictMode>)
async function mockCheck(id?: string, path?: string) {
  const { nativeBridge } = await import("../src/bridge/nativeBridge")
  return nativeBridge.agentCheck("ssh-fixture", id, path)
}
