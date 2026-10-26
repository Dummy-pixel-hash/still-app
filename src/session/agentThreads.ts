import { useSyncExternalStore } from "react"
import { nativeBridge, type Unsubscribe } from "../bridge/nativeBridge"
import type { AgentLaunchOptions, AgentThreadEvent, AgentThreadSnapshot } from "../agents/types"
import { hostKey, normalizeFolder, type ConversationMeta } from "../agents/workspace"
import type { Session } from "../types"

export type AgentThreadRow = AgentThreadSnapshot & { touchedAt: number; meta: ConversationMeta; previousTranscript?: AgentThreadEvent[] }
const rows = new Map<string, AgentThreadRow>()
const listeners = new Set<() => void>()
const subscriptions = new Map<string, Unsubscribe>()
const subscribing = new Map<string, Promise<void>>()
const restored = new Set<string>()
const tombstones = new Set<string>()
const INDEX_KEY = "still.agents.index.v2"
let saveError: string | undefined
function metadata(row: AgentThreadSnapshot & { meta?: ConversationMeta; touchedAt?: number }): ConversationMeta {
  const defaults = { id: row.executionId, hostKey: "", folder: normalizeFolder(row.cwd), title: "", pinned: false, createdAt: row.touchedAt || Date.now(), activityAt: row.touchedAt || Date.now(), order: row.touchedAt || Date.now(), draft: "" }
  if (!row.meta || typeof row.meta !== "object") return defaults
  return { ...defaults, ...row.meta, id: typeof row.meta.id === "string" ? row.meta.id : defaults.id, hostKey: typeof row.meta.hostKey === "string" ? row.meta.hostKey : "", title: typeof row.meta.title === "string" ? row.meta.title : "", folder: typeof row.meta.folder === "string" ? row.meta.folder : defaults.folder, draft: typeof row.meta.draft === "string" ? row.meta.draft : "" }
}
let version = 0
const emit = () => { version++; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const snapshotVersion = () => version
export function useAgentThreads(): AgentThreadRow[] {
  useSyncExternalStore(subscribe, snapshotVersion, snapshotVersion)
  return [...rows.values()].sort((a, b) => b.touchedAt - a.touchedAt)
}
export function useAgentSaveError() {
  useSyncExternalStore(subscribe, snapshotVersion, snapshotVersion)
  return saveError
}
function persist() {
  try {
    const data = [...rows.values()].sort((a, b) => b.touchedAt - a.touchedAt)
      .map(({ previousTranscript, ...row }) => ({ ...row, previousEventCount: previousTranscript?.filter(event => event.type !== "permission" && event.type !== "input").length || 0, pendingPermission: undefined, pendingInput: undefined, transcript: row.transcript.filter(event => event.type !== "permission" && event.type !== "input") }))
    localStorage.setItem(INDEX_KEY, JSON.stringify(data))
    localStorage.setItem("still.agents.deleted.v2", JSON.stringify([...tombstones]))
    saveError = undefined
  } catch { saveError = "Conversation changes could not be saved on this device. Keep Still open and copy important messages before restarting." }
}
function restore() {
  try {
    const deleted: unknown = JSON.parse(localStorage.getItem("still.agents.deleted.v2") || "[]")
    if (Array.isArray(deleted)) deleted.filter(id => typeof id === "string").forEach(id => tombstones.add(id))
    const data: unknown = JSON.parse(localStorage.getItem(INDEX_KEY) || localStorage.getItem("still.agents.index.v1") || "[]")
    if (!Array.isArray(data)) return
    for (const row of data) {
      if (!row || typeof row.executionId !== "string" || typeof row.localSessionId !== "string" || !Array.isArray(row.transcript)) continue
      if (tombstones.has(row.executionId)) continue
      rows.set(row.executionId, { ...row, meta: metadata(row), configOptions: Array.isArray(row.configOptions) ? row.configOptions : [],
        previousTranscript: Number.isSafeInteger(row.previousEventCount) && row.previousEventCount > 0 ? row.transcript.slice(0, row.previousEventCount) : undefined,
        state: "error", turnActive: false, pendingPermission: undefined, pendingInput: undefined,
        lastError: row.resumable ? "This conversation is saved. Resume it to continue." : "This thread belonged to a previous Still process. Its transcript is read-only; start a new thread." })
      restored.add(row.executionId)
    }
  } catch { /* Ignore corrupt or unavailable local cache. */ }
}
restore()
function receive(row: AgentThreadRow, event: AgentThreadEvent) {
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= row.lastSequence) return
  row.lastSequence = event.sequence
  if (["userMessage", "threadComplete", "permission", "threadError"].includes(event.type)) { row.touchedAt = Date.now(); row.meta = { ...row.meta, activityAt: row.touchedAt } }
  if (event.type === "userMessage") { row.turnActive = true; row.lastError = undefined; if (!row.meta.title) row.meta = { ...row.meta, title: event.text?.split("\n")[0].slice(0, 160) || "" } }
  if (event.type === "threadState" && event.state) {
    row.state = event.state
    if (event.state === "working") { row.pendingPermission = undefined; row.pendingInput = undefined }
  }
  if (event.type === "permission" && event.permission) { row.pendingPermission = event.permission; row.state = "inputRequired" }
  if (event.type === "input" && event.input) { row.pendingInput = event.input; row.state = "inputRequired" }
  if (event.type === "threadComplete") { row.pendingPermission = undefined; row.pendingInput = undefined; row.turnActive = false; row.state = event.state || "complete"; row.lastError = undefined }
  if (event.type === "threadStopped") { row.pendingPermission = undefined; row.pendingInput = undefined; row.turnActive = true; row.state = "working"; row.lastError = event.text || "Waiting for remote cancellation confirmation." }
  if (event.type === "configOptions" && event.configOptions) row.configOptions = event.configOptions
  if (event.type === "commands" && event.commands) row.commands = event.commands
  if (event.type === "threadError") { row.pendingPermission = undefined; row.pendingInput = undefined; row.turnActive = false; row.state = "error"; row.lastError = event.text || "Remote agent error." }
  const last = row.transcript[row.transcript.length - 1]
  if ((event.type === "assistantChunk" || event.type === "reasoningChunk") && last?.type === event.type && last.messageId === event.messageId) {
    row.transcript = [...row.transcript.slice(0, -1), { ...last, text: (last.text || "") + (event.text || "") }]
  } else row.transcript = [...row.transcript, event]
  // Streaming chunks need not synchronously serialize the whole history every token.
  if (event.type !== "assistantChunk" && event.type !== "reasoningChunk") persist()
  emit()
}
export async function refreshAgentThread(id: string) {
  const current = await nativeBridge.agentSnapshot(id)
  if (!current || typeof current.executionId !== "string") throw new Error("This remote agent process is no longer available.")
  const old = rows.get(id)
  // A newer live event can arrive while the snapshot request is in flight.
  if (tombstones.has(id)) return
  if (!old || current.lastSequence >= old.lastSequence) {
    const previous = old?.previousTranscript || []
    const live = old?.transcript.slice(previous.length) || []
    const first = current.transcript[0]?.sequence
    const prefix = first === undefined ? live : live.filter(event => event.sequence < first)
    rows.set(id, { ...current, previousTranscript: old?.previousTranscript, transcript: [...previous, ...prefix, ...current.transcript], meta: old?.meta || metadata(current), touchedAt: old?.touchedAt || Date.now() })
  }
  restored.delete(id)
  persist(); emit()
}
export function subscribeRemoteAgent(id: string): Promise<void> {
  if (subscribing.has(id)) return subscribing.get(id)!
  if (subscriptions.has(id)) return Promise.resolve()
  const task = (async () => {
    try {
      const stop = await nativeBridge.subscribeToAgent(id, event => { const row = rows.get(id); if (row) receive(row, event) })
      subscriptions.set(id, stop)
      await refreshAgentThread(id)
    } catch (error) {
      subscriptions.get(id)?.(); subscriptions.delete(id)
      const row = rows.get(id)
      if (row) {
        row.state = "submissionUnknown"; row.pendingPermission = undefined; row.pendingInput = undefined; row.turnActive = false
        row.lastError = restored.has(id) ? row.resumable ? "This conversation is saved. Resume it to continue." : "This thread belonged to a previous Still process. Its transcript is read-only; start a new thread." : error instanceof Error ? error.message : "Remote process is unavailable. Inspect the server before retrying."
        persist(); emit()
      }
    }
  })().finally(() => subscribing.delete(id))
  subscribing.set(id, task)
  return task
}
export async function sendAgentMessage(id: string, message: string) {
  const row = rows.get(id)
  if (!row || !["working", "complete", "cancelled"].includes(row.state) || row.turnActive) throw new Error("Agent is not ready for another prompt.")
  // Sequence numbers and the user message come from the native runner, not an optimistic counter.
  row.turnActive = true; row.lastError = undefined; emit()
  try { await nativeBridge.agentSend(id, message) }
  catch (error) {
    const current = rows.get(id)!
    current.state = "submissionUnknown"; current.turnActive = false
    current.lastError = error instanceof Error ? error.message : "The prompt may have reached the server. Inspect it before retrying."
    persist(); emit(); throw error
  }
}
export async function respondAgentPermission(id: string, requestId: string | number, optionId: string) {
  const row = rows.get(id)
  if (!row?.pendingPermission || row.pendingPermission.requestId !== requestId || !row.pendingPermission.options.some(option => option.optionId === optionId)) throw new Error("This permission is stale. Refresh the agent thread.")
  await nativeBridge.agentRespondPermission(id, requestId, optionId)
}
export function cancelAgentTurn(id: string) { return nativeBridge.agentCancel(id) }
export async function startRemoteAgent(nativeId: string, localId: string, agentId: string, options?: AgentLaunchOptions, owner?: Session, onCreated?: (row: AgentThreadRow) => void) {
  if (!nativeId) throw new Error("Connect to this server in Still and verify its host key first.")
  const current = await nativeBridge.agentStart(nativeId, localId, agentId, options)
  rows.set(current.executionId, { ...current, meta: metadata(current), touchedAt: Date.now() }); persist(); emit()
  // Failed startup still belongs to its server/folder and remains inspectable.
  if (owner) { rows.get(current.executionId)!.meta.hostKey = hostKey(owner); persist(); emit() }
  onCreated?.(rows.get(current.executionId)!)
  await subscribeRemoteAgent(current.executionId)
  if (rows.get(current.executionId)?.state === "connecting") await waitForAgentReady(current.executionId)
  return rows.get(current.executionId)!
}
function waitForAgentReady(id: string) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const check = () => {
      const row = rows.get(id)
      if (row?.state === "connecting") return
      listeners.delete(check); clearTimeout(timer)
      if (row && ["working", "complete", "cancelled"].includes(row.state)) resolve()
      else reject(new Error(row?.lastError || "The agent could not start. Check its installation and sign-in."))
    }
    timer = setTimeout(() => { listeners.delete(check); reject(new Error("Agent initialisation timed out. Check its installation and sign-in.")) }, 50000)
    listeners.add(check); check()
  })
}
export function threadTitle(row: AgentThreadRow) {
  return row.meta.title || row.transcript.find(event => event.type === "userMessage")?.text?.split("\n")[0] || `New ${row.agentName} conversation`
}
export function claimAgentThreads(session: Session, relatedSessionIds: string[]) {
  let changed = false
  for (const row of rows.values()) if (!row.meta.hostKey && relatedSessionIds.includes(row.localSessionId)) {
    row.meta = { ...row.meta, hostKey: hostKey(session), folder: normalizeFolder(row.cwd) }; changed = true
  }
  if (changed) { persist(); emit() }
}
export function updateThreadMeta(id: string, patch: Partial<ConversationMeta>) {
  const row = rows.get(id)
  if (!row) return
  row.meta = { ...row.meta, ...patch, id: row.meta.id }; persist(); emit()
}
export function clearAgentDraft(id: string, submitted: string) {
  const row = rows.get(id)
  if (row?.meta.draft.trim() === submitted.trim()) updateThreadMeta(id, { draft: "" })
}
export async function deleteAgentThread(id: string) {
  const row = rows.get(id)
  if (!row) return
  if (row.turnActive) throw new Error("Stop this conversation before deleting it.")
  if (!restored.has(id)) await nativeBridge.agentClose(id)
  tombstones.add(id); rows.delete(id); restored.delete(id)
  subscriptions.get(id)?.(); subscriptions.delete(id)
  persist(); emit()
}
export function canResumeAgentThread(row: AgentThreadRow) {
  return !!row.resumable && !!row.agentSessionId && !row.turnActive && !row.pendingInput && !row.pendingPermission && (restored.has(row.executionId) || row.state === "error")
}
export async function resumeAgentThread(id: string, start: (agent: string, options: AgentLaunchOptions) => Promise<AgentThreadRow>, executable?: string) {
  const row = rows.get(id)
  if (!row || !canResumeAgentThread(row)) throw new Error("Refresh this conversation before resuming. An uncertain or active execution cannot be replaced safely.")
  if (!restored.has(id)) await nativeBridge.agentClose(id)
  const next = await start(row.agentId, { cwd: row.cwd, resumeSessionId: row.agentSessionId, executable })
  if (!idleState(next)) throw new Error(next.lastError || "The saved agent session could not be resumed.")
  next.meta = { ...row.meta }
  next.previousTranscript = row.transcript
  next.transcript = [...row.transcript, ...next.transcript]
  tombstones.add(id); rows.delete(id); restored.delete(id)
  subscriptions.get(id)?.(); subscriptions.delete(id)
  persist(); emit(); return next
}
const idleState = (row: AgentThreadRow) => ["working", "complete", "cancelled"].includes(row.state) && !row.turnActive
export async function setAgentConfig(id: string, configId: string, value: string | boolean) {
  const row = rows.get(id)
  if (!row || row.turnActive || !["working", "complete", "cancelled"].includes(row.state)) throw new Error("Wait until the agent is idle before changing its settings.")
  await nativeBridge.agentSetConfig(id, configId, value)
  await refreshAgentThread(id)
}
