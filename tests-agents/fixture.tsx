import React from "react"
import { createRoot } from "react-dom/client"
import "../src/styles/theme.css"
import AgentWorkspace from "../src/components/AgentWorkspace"
import { AGENTS, type AgentThreadEvent, type AgentThreadSnapshot } from "../src/agents/types"
import { registerNativeBridge } from "../src/bridge/nativeBridge"
import { mockBridge } from "../src/bridge/mockBridge"
import { startRemoteAgent } from "../src/session/agentThreads"
import Workspace from "../src/screens/Workspace"

// This bridge is installed only by this test entrypoint, never by production code.
const snapshots = new Map<string, AgentThreadSnapshot>()
const sinks = new Map<string, (event: AgentThreadEvent) => void>()
let counter = 0
const h = {
  checks: [] as unknown[], starts: [] as unknown[], sends: [] as string[], configs: [] as unknown[], approvals: [] as unknown[], closes: [] as string[], connects: [] as any[], inputs: [] as unknown[],
  rejectConfig: false, rejectSend: false, closed: false, resumable: false, requireAuth: false, hostKeyMode: "trusted", hostTrusted: false,
  trustCalls: 0, forgetCalls: 0, deferStartup: false, startupFail: false,
  releaseStartup: () => {},
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
    h.emit(id, { type: "toolStart", toolCallId: "read", title: "Read", toolKind: "read", rawInput: { path: "src/session/connections.ts" }, status: "in_progress" })
    h.emit(id, { type: "toolUpdate", toolCallId: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "export async function reconnect(id: string) {\n  return connectSession(id)\n}" } }] })
    h.emit(id, { type: "toolStart", toolCallId: "edit", title: "Update reconnect guard", status: "completed", content: [{ type: "diff", path: "src/session/connections.ts", oldText: "connectSession(id)", newText: "await connectSession(id)" }] })
    h.emit(id, { type: "plan", plan: [{ content: "Inspect the reconnect owner", status: "completed" }, { content: "Protect the current session", status: "in_progress" }, { content: "Verify reattachment", status: "pending" }] })
    h.emit(id, { type: "commands", commands: [{ name: "review", description: "Review the current changes" }, { name: "compact", description: "Compact this conversation" }, ...Array.from({length: 25}, (_, i) => ({ name: `team/command-${i}`, description: `Project command ${i}` }))] })
    h.finish()
  },
}
Object.assign(window, { agentFixture: h })
registerNativeBridge({
  ...mockBridge,
  agentCheck: async (_native, agentId, executable) => {
    h.checks.push({ agentId, executable })
    return (agentId ? AGENTS.filter(a => a.id === agentId) : AGENTS).map(a => ({ agentId: a.id, available: true, installed: true, runtime: a.id === "gemini" ? "acp" as const : "native" as const, runtimeAvailable: true, executable: executable || `/home/dev/.local/bin/${a.executable}` }))
  },
  agentStart: async (_native, localId, agentId, options) => {
    h.starts.push({ agentId, options })
    const row: AgentThreadSnapshot = { executionId: `fixture-${Date.now()}-${++counter}`, localSessionId: localId, agentId, agentName: AGENTS.find(a => a.id === agentId)!.label, agentSessionId: "acp-fixture", resumable: h.resumable, cwd: (options?.cwd || "/srv/still").replace(/^~\//,"/home/dev/"), state: h.deferStartup ? "connecting" : "working", lastSequence: 0, transcript: [], turnActive: false,
      configOptions: [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "Model A" }, { name: "Other", options: [{ value: "b", name: "Model B" }] }] },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code" }] },
        { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
      ] }
    snapshots.set(row.executionId, row)
    h.releaseStartup = () => {
      const current = snapshots.get(row.executionId)!
      current.state = h.startupFail ? "error" : "working"
      if (h.startupFail) current.lastError = "Agent startup was rejected"
      h.emit(current.executionId, h.startupFail ? { type: "threadError", text: "Agent startup was rejected" } : { type: "threadState", state: "working" })
    }
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
  agentClose: async id => { h.closes.push(id); snapshots.delete(id); sinks.delete(id) },
  agentRespondInput: async (id, requestId, answers) => { h.inputs.push({ requestId, answers }); snapshots.get(id)!.pendingInput = undefined; h.emit(id, { type: "threadState", state: "working" }) },
  hasCredential: async () => !h.requireAuth,
  connect: async args => {
    h.connects.push(args)
    return { sessionId: `ssh-${h.connects.length}`, status: h.hostKeyMode !== "trusted" && !h.hostTrusted ? "connecting" : "connected" }
  },
  subscribeToSession: async (_id, callback) => {
    if (h.hostKeyMode !== "trusted" && !h.hostTrusted) callback({ type: "hostKeyPrompt", prompt: { host: "dev.example.test", port: 22, keyType: "ssh-ed25519", fingerprint: "SHA256:explicit-test-fingerprint", opensshKey: "ssh-ed25519 synthetic-test-key", changed: h.hostKeyMode === "changed" } })
    return () => {}
  },
  status: async () => ({ status: h.hostKeyMode !== "trusted" && !h.hostTrusted ? "error" : "connected", lastError: h.hostKeyMode !== "trusted" && !h.hostTrusted ? { code: "host_key_unknown", message: "Verify the server identity" } : null }),
  trustHost: async () => { h.trustCalls++; h.hostTrusted = true },
  forgetHost: async () => { h.forgetCalls++; h.hostKeyMode = "unknown" },
})

const session = { id: "agent-fixture", name: "Development", host: "dev.example.test", port: 22, username: "dev", projectId: "still", workingDirectory: "/srv/still", authMethod: "ask" as const, remember: false, tmuxSession: "still-dev", createdAt: 0, updatedAt: 0 }
const fullWorkspace = new URLSearchParams(location.search).has("workspace")
if (fullWorkspace) localStorage.setItem("still.m2.store.v1", JSON.stringify({ projects: [{id:"still",name:"Still",note:"",order:0}],sessions:[session],order:{still:[session.id]},keys:[],settings:{confirmRemove:true,terminal:{fontSize:14,cursorStyle:"block",scrollback:5000}} }))
createRoot(document.getElementById("root")!).render(<React.StrictMode>{fullWorkspace ? <Workspace /> : <AgentWorkspace session={session} onClose={() => { h.closed = true }} onStart={(id, options, onCreated) => startRemoteAgent("ssh-fixture", session.id, id, options, session, onCreated)} onCheck={(id, path) => mockCheck(id, path)} />}</React.StrictMode>)
async function mockCheck(id?: string, path?: string) {
  const { nativeBridge } = await import("../src/bridge/nativeBridge")
  return nativeBridge.agentCheck("ssh-fixture", id, path)
}
