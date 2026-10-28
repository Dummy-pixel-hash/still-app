import React from "react"
import { createRoot } from "react-dom/client"
import "../src/styles/theme.css"
import AgentWorkspace from "../src/components/AgentWorkspace"
import { AGENTS, type AgentThreadEvent, type AgentThreadSnapshot } from "../src/agents/types"
import { nativeBridge, registerNativeBridge } from "../src/bridge/nativeBridge"
import { mockBridge } from "../src/bridge/mockBridge"
import { reattachAgentThread, startRemoteAgent } from "../src/session/agentThreads"
import Workspace from "../src/screens/Workspace"
import { hostKey } from "../src/agents/workspace"
import { flushAgentSaves } from "../src/session/agentStorage"
import { createAgentDemo } from "./demo"
import "./demo.css"

// This bridge is installed only by this test entrypoint, never by production code.
const snapshots = new Map<string, AgentThreadSnapshot>()
const sinks = new Map<string, (event: AgentThreadEvent) => void>()
const preview = new URLSearchParams(location.search).has("demo") && !new URLSearchParams(location.search).has("workspace")
const scenario = preview ? new URLSearchParams(location.search).get("scenario") : null
const libraryKey = preview ? `still.test.agent-demo-library.v2${scenario ? `.${scenario}` : ""}` : "still.test.agent-library"
const library = () => JSON.parse(localStorage.getItem(libraryKey) || '{"rows":[],"workspaces":{},"deleted":[]}')
const saveLibrary = (value: unknown) => { if (h.failSave) throw new Error("Local disk is unavailable"); localStorage.setItem(libraryKey, JSON.stringify(value)) }
const modelOptions = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "Model A" }, { name: "Other", options: [{ value: "b", name: "Model B" }] }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask", description: "Answer questions before making changes." }, { value: "code", name: "Code", description: "Make changes directly." }] },
  { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
]
const projectCommands = [{ name: "review", description: "Review the current changes" }, { name: "compact", description: "Compact this conversation" }, ...Array.from({ length: 25 }, (_, i) => ({ name: `team/command-${i}`, description: `Project command ${i}` })), { name: "skill:security-review", description: "Audit security boundaries", route: "skill" as const, source: "Skill" }]
let counter = 0
const h = {
  checks: [] as unknown[], starts: [] as unknown[], sends: [] as string[], configs: [] as unknown[], approvals: [] as unknown[], closes: [] as string[], connects: [] as any[], inputs: [] as unknown[],
  sentConfigs: [] as Array<{ agent: string; model: string | boolean | undefined }>, reverts: [] as Array<{ id: string; messageId: string }>, rejectRevert: false, unknownRevert: false, deferRevert: false,
  releaseRevert: () => {}, releaseStartups: new Map<string, () => void>(),
  external: [] as string[],
  attaches: [] as string[],
  catalogs: [] as unknown[], resolutions: [] as string[], copied: "", failSave: false,
  flush: flushAgentSaves,
  saved: library,
  trimSnapshot: (count: number) => { const row = snapshots.get(h.current)!; row.transcript = row.transcript.slice(-count) },
  rejectConfig: false, rejectSend: false, rejectResponse: false, deferResponse: false, deferConfig: false, unknownResponse: false, failSnapshot: false,
  releaseResponse: () => {}, releaseConfig: () => {},
  closed: false, resumable: false, persistent: false, requireAuth: false, hostKeyMode: "trusted", hostTrusted: false,
  trustCalls: 0, forgetCalls: 0, deferStartup: false, startupFail: false,
  releaseStartup: () => {},
  emit(id: string, event: Omit<AgentThreadEvent, "sequence">) {
    const row = snapshots.get(id)!
    const value = { ...event, attemptId: row.executionId, sequence: ++row.lastSequence }
    const apply = (events: AgentThreadEvent[]) => {
      if (event.type === "historyReverted") { const index = events.findIndex(message => message.type === "userMessage" && message.messageId === event.messageId); if (index >= 0) events.splice(index) }
      if (event.type === "messageCheckpoint") { const message = events.find(message => message.type === "userMessage" && message.messageId === event.messageId); if (message) message.checkpoint = event.checkpoint }
    }
    apply(row.transcript)
    row.transcript.push(value)
    if (event.type === "userMessage") { row.turnActive = true; row.state = "working" }
    if (event.type === "threadComplete") { row.turnActive = false; row.state = event.state || "working"; row.pendingPermission = undefined; row.pendingInput = undefined; row.lastError = undefined }
    if (event.type === "threadState" && event.state) { row.state = event.state; if (event.state === "working") { row.pendingPermission = undefined; row.pendingInput = undefined } }
    if (event.type === "threadError") { row.state = event.state || "error"; row.lastError = event.text; row.turnActive = false; row.pendingInput = undefined; row.pendingPermission = undefined }
    if (event.type === "historyReverted") { row.state = "working"; row.lastError = undefined }
    if (event.type === "permission") { row.pendingPermission = event.permission; row.state = "inputRequired" }
    if (event.type === "input") { row.pendingInput = event.input; row.state = "inputRequired" }
    if (event.type === "requestOutcome") { if (event.requestOutcome?.kind === "question") row.pendingInput = undefined; else row.pendingPermission = undefined }
    if (event.type === "configOptions") row.configOptions = event.configOptions!
    if (event.type === "commands") row.commands = event.commands
    value.turnActive = row.turnActive
    const data = library(), saved = data.rows.find((item: any) => item.conversationId === row.conversationId)
    if (saved) {
      const transcript = saved.transcript; apply(transcript)
      const stored = value.type === "input" || value.type === "permission" ? {
        sequence: value.sequence, attemptId: value.attemptId, type: "agentRequest",
        request: { requestId: (value.input || value.permission)!.requestId, title: (value.input || value.permission)!.title, kind: value.type === "input" ? "question" : "permission" },
      } : value
      const next = [...transcript, stored]
      row.activeMessageIds = next.filter((event: AgentThreadEvent) => event.type === "userMessage" && event.messageId).map((event: AgentThreadEvent) => event.messageId!)
      Object.assign(saved, structuredClone(row), { transcript: next, pendingInput: null, pendingPermission: null }); saveLibrary(data)
    }
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
    h.emit(id, { type: "commands", commands: projectCommands })
    h.finish()
  },
}
Object.assign(window, { agentFixture: h })
registerNativeBridge({
  ...mockBridge,
  agentLibrary: async () => ({ ...library(), storagePath: "Fixture native-store boundary", warnings: [], liveExecutions: preview && scenario ? [...snapshots.keys()] : [] }),
  agentMigrate: async (rows, deleted, workspaces) => {
    const data = library(); data.deleted.push(...deleted)
    for (const value of rows) { const row = value as any; const id = row.meta.id; if (!data.deleted.includes(id) && !data.rows.some((item: any) => item.meta.id === id)) data.rows.push({ ...row, conversationId: id }) }
    data.workspaces = { ...workspaces, ...data.workspaces }; saveLibrary(data); return []
  },
  agentSaveMetadata: async (id, meta) => { const data = library(); const row = data.rows.find((item: any) => item.meta.id === id); if (!row) throw new Error("Conversation missing"); row.meta = meta; saveLibrary(data) },
  agentSaveWorkspace: async (key, value) => { const data = library(); data.workspaces[key] = value; saveLibrary(data) },
  agentDeleteSaved: async id => { const data = library(); data.rows = data.rows.filter((item: any) => item.meta.id !== id); data.deleted.push(id); saveLibrary(data) },
  agentCatalog: async (_native, agentId, cwd, executable) => { h.catalogs.push({ agentId, cwd, executable }); return { configOptions: structuredClone(modelOptions), commands: projectCommands, version: "2.fixture" } },
  agentResolveFolder: async (_native, cwd) => { h.resolutions.push(cwd); if (cwd.includes("missing")) throw new Error("The remote folder does not exist"); return cwd.replace(/^~\//, "/home/dev/") },
  clipboardWriteText: async text => { h.copied = text },
  async openExternal(url) { h.external.push(url) },
  agentCheck: async (_native, agentId, executable) => {
    h.checks.push({ agentId, executable })
    return (agentId ? AGENTS.filter(a => a.id === agentId) : AGENTS).map(a => ({ agentId: a.id, available: true, installed: true, runtime: a.id === "gemini" ? "acp" as const : "native" as const, runtimeAvailable: true, executable: executable || `/home/dev/.local/bin/${a.executable}` }))
  },
  agentStart: async (_native, localId, agentId, options) => {
    h.starts.push({ agentId, options })
    const row: AgentThreadSnapshot = { executionId: `fixture-${Date.now()}-${++counter}`, localSessionId: localId, agentId, agentName: AGENTS.find(a => a.id === agentId)!.label, agentSessionId: "acp-fixture", resumable: h.resumable, cwd: (options?.cwd || "/srv/still").replace(/^~\//,"/home/dev/"), state: h.deferStartup ? "connecting" : "working", lastSequence: 0, transcript: [], turnActive: false,
      configOptions: h.deferStartup ? [] : structuredClone(modelOptions), commands: h.deferStartup ? [] : projectCommands, persistent:h.persistent, historyCapabilities: { revert: ["pi", "codex", "opencode"].includes(agentId), retry: ["pi", "codex", "opencode"].includes(agentId) } }
    row.conversationId = options?.conversationId || row.executionId
    row.hostKey = hostKey(session)
    snapshots.set(row.executionId, row)
    const data = library(), prior = data.rows.find((item: any) => item.conversationId === row.conversationId)
    if (prior) { row.activeMessageIds = prior.transcript.filter((event: AgentThreadEvent) => event.type === "userMessage" && event.messageId).map((event: AgentThreadEvent) => event.messageId!); Object.assign(prior, row, { meta: prior.meta, transcript: prior.transcript }) }
    else data.rows.push({ ...row, meta: { id: row.conversationId, hostKey: row.hostKey, folder: row.cwd, title: "", pinned: false, createdAt: Date.now(), activityAt: Date.now(), order: Date.now(), draft: "" }, touchedAt: Date.now() })
    saveLibrary(data)
    h.releaseStartup = () => {
      const current = snapshots.get(row.executionId)!
      current.state = h.startupFail ? "error" : "working"
      if (h.startupFail) current.lastError = "Agent startup was rejected"
      else { h.emit(current.executionId, { type: "configOptions", configOptions: structuredClone(modelOptions) }); h.emit(current.executionId, { type: "commands", commands: projectCommands }) }
      h.emit(current.executionId, h.startupFail ? { type: "threadError", text: "Agent startup was rejected" } : { type: "threadState", state: "working" })
    }
    h.releaseStartups.set(row.executionId, h.releaseStartup)
    return structuredClone(row)
  },
  agentSnapshot: async id => { if (h.failSnapshot) throw new Error("Agent connection unavailable"); return structuredClone(snapshots.get(id)!) },
  agentAttach: async (_native, id) => { h.attaches.push(id); const row = snapshots.get(id); if (!row) throw new Error("Persistent worker unavailable"); h.emit(id,{ type:"threadState",state:row.pendingInput || row.pendingPermission ? "inputRequired" : "working" }); return structuredClone(row) },
  subscribeToAgent: async (id, callback) => { sinks.set(id, callback); return () => { sinks.delete(id) } },
  agentSend: async (id, message) => {
    if (h.rejectSend) throw new Error("SSH disconnected. Submission is uncertain.")
    const row = snapshots.get(id)!
    h.sends.push(message)
    h.sentConfigs.push({ agent: row.agentId, model: row.configOptions.find(option => option.category === "model")?.currentValue })
    const messageId = `${id}:message:${row.lastSequence + 1}`
    h.emit(id, { type: "userMessage", text: message, messageId })
    h.emit(id, { type: "assistantChunk", text: "First " }); h.emit(id, { type: "assistantChunk", text: "second " }); h.emit(id, { type: "assistantChunk", text: "third." })
    if (row.historyCapabilities?.revert) h.emit(id, { type: "messageCheckpoint", messageId, checkpoint: { provider: row.agentId, id: messageId } })
  },
  agentRevert: async (id, messageId, expectedSequence) => {
    const row = snapshots.get(id)!
    if (!row.historyCapabilities?.revert || row.turnActive || row.lastSequence !== expectedSequence) throw new Error("History is not ready to change")
    const saved = library().rows.find((row: any) => row.executionId === id)
    const message = saved?.transcript.find((event: AgentThreadEvent) => event.type === "userMessage" && event.messageId === messageId)
    if (!message?.checkpoint) throw new Error("The provider checkpoint is missing")
    h.reverts.push({ id, messageId })
    const previous = row.state
    h.emit(id, { type: "threadState", state: "rewinding" })
    if (h.deferRevert) await new Promise<void>(resolve => { h.releaseRevert = resolve })
    if (h.rejectRevert || h.unknownRevert) {
      h.emit(id, { type: "threadError", state: h.unknownRevert ? "submissionUnknown" : previous, text: h.unknownRevert ? "History acknowledgement was lost" : "Provider rejected the history change" })
      throw new Error(h.unknownRevert ? "History acknowledgement was lost" : "Provider rejected the history change")
    }
    h.emit(id, { type: "historyReverted", messageId, text: message.text })
    return structuredClone(row)
  },
  agentSetConfig: async (id, configId, value) => {
    if (h.rejectConfig) throw new Error("The agent rejected that setting.")
    h.configs.push({ configId, value })
    if (h.deferConfig) await new Promise<void>(resolve => { h.releaseConfig = resolve })
    const row = snapshots.get(id)!
    row.configOptions.find(option => option.id === configId)!.currentValue = value
    h.emit(id, { type: "configOptions", configOptions: structuredClone(row.configOptions) })
  },
  agentRespondPermission: async (id, requestId, optionId) => {
    const row = snapshots.get(id)!, request = row.pendingPermission, option = request?.options.find(value => value.optionId === optionId)
    if (!request || request.requestId !== requestId || !option) throw new Error("This permission is no longer pending")
    if (h.rejectResponse) throw new Error("Response could not be sent. Check the connection and retry.")
    if (h.deferResponse) await new Promise<void>(resolve => { h.releaseResponse = resolve })
    h.approvals.push({ requestId, optionId }); row.pendingPermission = undefined
    if (request) h.emit(id, { type: "requestOutcome", requestOutcome: { requestId, kind: "permission", title: request.title, outcome: /reject|deny|decline/i.test(`${option?.kind} ${option?.name}`) ? "rejected" : "approved", responseLabel: option?.name } })
    h.emit(id, { type: "threadState", state: "working" })
    if (h.unknownResponse) throw new Error("Response acknowledgement was lost")
  },
  agentCancel: async id => { h.emit(id, { type: "threadStopped", text: "Cancellation requested" }); h.finish() },
  agentClose: async id => { h.closes.push(id); snapshots.delete(id); sinks.delete(id) },
  agentRespondInput: async (id, requestId, answers) => {
    const row = snapshots.get(id)!, request = row.pendingInput
    if (!request || request.requestId !== requestId) throw new Error("This question is no longer pending")
    if (h.rejectResponse) throw new Error("Response could not be sent. Check the connection and retry.")
    if (h.deferResponse) await new Promise<void>(resolve => { h.releaseResponse = resolve })
    h.inputs.push({ requestId, answers }); row.pendingInput = undefined
    if (request) h.emit(id, { type: "requestOutcome", requestOutcome: { requestId, kind: "question", title: request.title, outcome: answers ? "answered" : "dismissed" } })
    h.emit(id, { type: "threadState", state: "working" })
    if (h.unknownResponse) throw new Error("Response acknowledgement was lost")
  },
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
if (preview && !localStorage.getItem(libraryKey)) saveLibrary(createAgentDemo(session))
if (preview && scenario) {
  const demo = createAgentDemo(session), row = demo.rows[0]
  row.configOptions = [
    { id:"model",name:"Model",type:"select",category:"model",currentValue:"anthropic/claude-sonnet-4",options:[{name:"Anthropic",options:[{value:"anthropic/claude-sonnet-4",name:"Claude Sonnet 4",description:"Everyday coding and collaboration"},{value:"anthropic/claude-opus-4",name:"Claude Opus 4",description:"Complex reasoning and architecture"}]},{name:"OpenAI",options:[{value:"openai/gpt-5",name:"GPT-5"}]},{name:"Google",options:[{value:"google/gemini-2.5-pro",name:"Gemini 2.5 Pro"}]}] },
    { id:"mode",name:"Agent",type:"select",category:"mode",currentValue:"build",options:[{value:"build",name:"Build",description:"Implement changes in your project"},{value:"plan",name:"Plan",description:"Explore and plan before making changes"}] },
    { id:"effort",name:"Reasoning",type:"select",category:"thought_level",currentValue:"medium",options:[{value:"low",name:"Low"},{value:"medium",name:"Medium"},{value:"high",name:"High"}] },
  ]
  row.state = "working"; row.turnActive = false
  if (scenario === "question") {
    row.meta.title = "Choose the implementation approach"
    const input = { requestId:"demo-question",title:"A couple of choices before I start",schema:{ properties:{ approach:{type:"string",title:"How should authentication work?",description:"I found an existing session layer. Which direction should I take?",oneOf:[{const:"existing",title:"Extend the existing session",description:"Keep the current sign-in flow and add token refresh."},{const:"oauth",title:"Add an OAuth provider",description:"Use a hosted identity provider instead."}]},checks:{type:"array",title:"What should I include?",items:{enum:["Unit tests","Integration tests","Setup documentation"]}},note:{type:"string",title:"Anything else I should know?"}},required:["approach"]} }
    row.pendingInput = input; row.state = "inputRequired"; row.turnActive = true
    row.transcript.push({type:"input",input,sequence:++row.lastSequence,attemptId:row.executionId})
  }
  if (scenario === "approval") {
    row.meta.title = "Review the requested operation"
    const permission = {requestId:"demo-permission",sessionId:row.agentSessionId!,toolCallId:"demo-checks",title:"Run the project’s checks",description:"The implementation is ready. I’d like to run the build and tests to check for regressions.",command:"npm run build\nnpm test",rawInput:{command:"npm run build && npm test",cwd:"/srv/still"},options:[{optionId:"reject",name:"Reject",kind:"reject_once"},{optionId:"allow",name:"Allow once",kind:"allow_once"}]}
    row.pendingPermission = permission; row.state = "inputRequired"; row.turnActive = true
    row.transcript.push({type:"permission",permission,sequence:++row.lastSequence,attemptId:row.executionId})
  }
  snapshots.set(row.executionId,structuredClone(row)); saveLibrary(demo)
}
const fullWorkspace = new URLSearchParams(location.search).has("workspace")
if (fullWorkspace) localStorage.setItem("still.m2.store.v1", JSON.stringify({ projects: [{id:"still",name:"Still",note:"",order:0}],sessions: new URLSearchParams(location.search).has("empty") ? [] : [session],order:{still:[session.id]},keys:[],settings:{confirmRemove:true,terminal:{fontSize:14,cursorStyle:"block",scrollback:5000}} }))
createRoot(document.getElementById("root")!).render(<React.StrictMode>{preview && <header className="agent-demo-banner"><strong>Still · interactive preview</strong><span>Synthetic · no server connection</span><nav aria-label="Preview scenarios"><a href="?demo&scenario=models">Models</a><a href="?demo&scenario=question">Questions</a><a href="?demo&scenario=approval">Approvals</a><a href="/tests-agents/fixture.html">Blank workspace</a></nav></header>}{fullWorkspace ? <Workspace /> : <AgentWorkspace session={session} sessions={[session]} transportId="ssh-fixture" onReattach={row => reattachAgentThread(row.executionId,"ssh-fixture")} onClose={() => { h.closed = true }} onStart={(id, options, onCreated) => startRemoteAgent("ssh-fixture", session.id, id, options, session, onCreated)} onCheck={(id, path) => mockCheck(id, path)} onCatalog={(agent, cwd, executable) => nativeBridge.agentCatalog("ssh-fixture", agent, cwd, executable)} onResolveFolder={cwd => nativeBridge.agentResolveFolder("ssh-fixture", cwd)} />}</React.StrictMode>)
if (preview && scenario) {
  const observer = new MutationObserver(() => {
    const row = document.querySelector<HTMLButtonElement>('.agent-thread-open')
    if (!row) return
    observer.disconnect(); row.click()
    if (scenario === "models") requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.agent-model-trigger')?.click())
  })
  observer.observe(document.getElementById("root")!,{childList:true,subtree:true})
}
async function mockCheck(id?: string, path?: string) {
  const { nativeBridge } = await import("../src/bridge/nativeBridge")
  return nativeBridge.agentCheck("ssh-fixture", id, path)
}
