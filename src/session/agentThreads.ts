import { useSyncExternalStore } from "react"
import { nativeBridge, type Unsubscribe } from "../bridge/nativeBridge"
import type { AgentCatalog, AgentLaunchOptions, AgentThreadEvent, AgentThreadSnapshot } from "../agents/types"
import { hostKey, normalizeFolder, type ConversationMeta } from "../agents/workspace"
import type { Session } from "../types"
import { discardAgentSave, flushAgentSaves, initializeAgentStorage, scheduleAgentSave, useAgentStorage } from "./agentStorage"

export type AgentThreadRow = AgentThreadSnapshot & { touchedAt: number; meta: ConversationMeta; previousTranscript?: AgentThreadEvent[] }
const rows = new Map<string, AgentThreadRow>()
const listeners = new Set<() => void>()
const subscriptions = new Map<string, Unsubscribe>()
const subscribing = new Map<string, Promise<void>>()
const restored = new Set<string>()
const tombstones = new Set<string>()
const historyOperations = new Set<string>()
const requestOperations = new Set<string>()
const unconfirmedRequests = new Set<string>()
const INDEX_KEY = "still.agents.index.v2"
function metadata(row: AgentThreadSnapshot & { meta?: ConversationMeta; touchedAt?: number }): ConversationMeta {
  const defaults = { id: row.conversationId || row.executionId, hostKey: row.hostKey || "", folder: normalizeFolder(row.cwd), title: "", pinned: false, createdAt: row.touchedAt || Date.now(), activityAt: row.touchedAt || Date.now(), order: row.touchedAt || Date.now(), draft: "" }
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
  return useAgentStorage().error
}
function persist(row?: AgentThreadRow) {
  for (const current of row ? [row] : rows.values()) {
    const meta = { ...current.meta }
    scheduleAgentSave(meta.id, () => nativeBridge.agentSaveMetadata(meta.id, meta))
  }
}
let loading: Promise<void> | undefined
export function loadAgentThreads() {
  if (loading) return loading
  loading = initializeAgentStorage(() => {
    const data = JSON.parse(localStorage.getItem(INDEX_KEY) || localStorage.getItem("still.agents.index.v1") || "[]")
    const deleted = JSON.parse(localStorage.getItem("still.agents.deleted.v2") || "[]")
    return { rows: Array.isArray(data) ? data.map(row => row && typeof row === "object" && typeof row.cwd === "string" ? { ...row, meta: metadata(row) } : row) : [], deleted: Array.isArray(deleted) ? deleted.filter(id => typeof id === "string") : [], workspaces: JSON.parse(localStorage.getItem("still.agents.workspace.v2") || "{}") }
  }).then(async library => {
    for (const value of library.rows) {
      const row = value as AgentThreadRow & { previousEventCount?: number }
      if (!row || typeof row.executionId !== "string" || typeof row.localSessionId !== "string" || !Array.isArray(row.transcript)) continue
      if (tombstones.has(row.executionId) || rows.has(row.executionId)) continue
      const firstCurrent = row.transcript.findIndex(event => event.attemptId === row.executionId)
      const previousCount = firstCurrent > 0 ? firstCurrent : row.previousEventCount || (firstCurrent < 0 && row.transcript.some(event => event.attemptId) ? row.transcript.length : 0)
      rows.set(row.executionId, { ...row, meta: metadata(row), configOptions: Array.isArray(row.configOptions) ? row.configOptions : [],
        previousTranscript: previousCount ? row.transcript.slice(0, previousCount) : undefined,
        state: row.state === "submissionUnknown" || row.state === "rewinding" || row.meta?.submissionUnknown ? "submissionUnknown" : "saved", turnActive: false, pendingPermission: undefined, pendingInput: undefined, lastError: row.state === "submissionUnknown" || row.state === "rewinding" || row.meta?.submissionUnknown ? row.lastError || "The last operation was not confirmed. Inspect the provider session before continuing." : undefined })
      if (!library.liveExecutions?.includes(row.executionId)) restored.add(row.executionId)
    }
    emit()
    await Promise.all((library.liveExecutions || []).filter(id => rows.has(id)).map(id => subscribeRemoteAgent(id)))
    // A WebView reload can leave an unused pre-message connection behind.
    // Keep anything with a draft or prompt; retire only the empty preparation.
    await Promise.all([...rows.values()].filter(row => row.meta.prepared && !row.meta.draft && !row.transcript.some(event => event.type === "userMessage"))
      .map(row => discardPreparedAgent(row.executionId).catch(() => {})))
  }).catch(error => { loading = undefined; throw error })
  return loading
}
function receive(row: AgentThreadRow, event: AgentThreadEvent) {
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= row.lastSequence) return
  row.lastSequence = event.sequence
  if (event.remoteCursor !== undefined) row.remoteCursor = event.remoteCursor
  if (event.turnActive !== undefined) row.turnActive = event.turnActive
  if (["userMessage", "threadComplete", "permission", "input", "requestOutcome", "threadError"].includes(event.type)) { row.touchedAt = Date.now(); row.meta = { ...row.meta, activityAt: row.touchedAt } }
  if (event.type === "userMessage") { row.turnActive = true; row.lastError = undefined; if (!row.meta.title) row.meta = { ...row.meta, title: event.text?.split("\n")[0].slice(0, 160) || "" } }
  if (event.type === "threadState" && event.state) {
    row.state = event.state
    if (event.state === "detached") row.lastError = event.text || "The agent continues on the server. Reconnecting to catch up."
    else if (event.state === "working" || event.state === "connecting") row.lastError = undefined
    if (event.state === "working") { row.pendingPermission = undefined; row.pendingInput = undefined }
  }
  if (event.type === "permission" && event.permission) { row.pendingPermission = event.permission; row.state = "inputRequired" }
  if (event.type === "input" && event.input) { row.pendingInput = event.input; row.state = "inputRequired" }
  if (event.type === "requestOutcome" && event.requestOutcome) {
    if (event.requestOutcome.kind === "permission" && row.pendingPermission?.requestId === event.requestOutcome.requestId) row.pendingPermission = undefined
    if (event.requestOutcome.kind === "question" && row.pendingInput?.requestId === event.requestOutcome.requestId) row.pendingInput = undefined
  }
  if (event.type === "threadComplete") { row.pendingPermission = undefined; row.pendingInput = undefined; row.turnActive = false; row.state = event.state || "complete"; row.lastError = undefined; row.meta = { ...row.meta, submissionUnknown: false } }
  if (event.type === "threadStopped") { row.pendingPermission = undefined; row.pendingInput = undefined; row.turnActive = true; row.state = "working"; row.lastError = event.text || "Waiting for remote cancellation confirmation." }
  if (event.type === "configOptions" && event.configOptions) row.configOptions = event.configOptions
  if (event.type === "historyCapabilities" && event.historyCapabilities) row.historyCapabilities = event.historyCapabilities
  if (event.type === "messageCheckpoint") row.transcript = row.transcript.map(message => message.type === "userMessage" && message.messageId === event.messageId ? { ...message, checkpoint: event.checkpoint } : message)
  if (event.type === "historyReverted") {
    row.transcript = revertHistory(row.transcript, event.messageId)
    if (row.previousTranscript) row.previousTranscript = revertHistory(row.previousTranscript, event.messageId)
    row.state = "working"; row.lastError = undefined; row.meta = { ...row.meta, submissionUnknown: false }
  }
  if (event.type === "commands" && event.commands) row.commands = event.commands
  if (event.type === "threadError") {
    row.pendingPermission = undefined; row.pendingInput = undefined; row.turnActive = false
    row.state = row.meta.submissionUnknown ? "submissionUnknown" : event.state || "error"; row.lastError = event.text || "Remote agent error."
    if (row.state === "submissionUnknown") row.meta = { ...row.meta, submissionUnknown: true }
  }
  const last = row.transcript[row.transcript.length - 1]
  if ((event.type === "assistantChunk" || event.type === "reasoningChunk") && last?.type === event.type && last.messageId === event.messageId && last.attemptId === event.attemptId) {
    row.transcript = [...row.transcript.slice(0, -1), { ...last, endSequence: event.sequence, text: (last.text || "") + (event.text || "") }]
  } else row.transcript = [...row.transcript, event]
  // Streaming chunks need not synchronously serialize the whole history every token.
  if (["userMessage", "threadComplete", "permission", "input", "requestOutcome", "threadError", "historyReverted"].includes(event.type)) persist(row)
  if (["assistantChunk", "reasoningChunk", "toolUpdate"].includes(event.type)) scheduleRender()
  else emit()
}
function revertHistory(events: AgentThreadEvent[], messageId?: string) {
  const index = messageId ? events.findIndex(event => event.type === "userMessage" && event.messageId === messageId) : -1
  return index < 0 ? events : events.slice(0, index)
}
function reconcileHistory(events: AgentThreadEvent[]) {
  let result: AgentThreadEvent[] = []
  for (const event of events) {
    if (event.type === "historyReverted") result = revertHistory(result, event.messageId)
    if (event.type === "messageCheckpoint") result = result.map(message => message.type === "userMessage" && message.messageId === event.messageId ? { ...message, checkpoint: event.checkpoint } : message)
    result.push(event)
  }
  return result
}
function activeHistory(events: AgentThreadEvent[], messageIds?: string[]) {
  if (!messageIds) return events
  const active = new Set(messageIds)
  let keep = true
  return events.filter(event => {
    if (event.type === "userMessage") keep = !event.messageId || active.has(event.messageId)
    return keep || ["configOptions", "commands", "historyCapabilities", "historyReverted"].includes(event.type)
  })
}
let renderFrame = 0
function scheduleRender() { if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; emit() }) }
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
    const prefix = first === undefined ? live : live.filter(event => (event.endSequence || event.sequence) < first)
    const unresolved = current.state === "submissionUnknown" || old?.meta.submissionUnknown && !current.turnActive && current.lastSequence <= old.lastSequence
    const transcript = activeHistory(reconcileHistory([...previous, ...prefix, ...current.transcript]), current.activeMessageIds)
    rows.set(id, { ...current, ...(unresolved ? { state: "submissionUnknown" as const, lastError: current.lastError || old?.lastError } : {}), previousTranscript: old?.previousTranscript ? transcript.filter(event => event.attemptId !== id) : undefined, transcript, meta: old?.meta ? { ...old.meta, submissionUnknown: !!unresolved } : metadata(current), touchedAt: old?.touchedAt || Date.now() })
  }
  restored.delete(id)
  emit()
}
const attaching = new Map<string, Promise<void>>()
export function reattachAgentThread(id: string, nativeId: string): Promise<void> {
  const current = attaching.get(id)
  if (current) return current
  const row = rows.get(id)
  if (!row?.persistent || !nativeId) return Promise.reject(new Error("Connect this conversation’s server before reattaching."))
  const task = (async () => {
    await nativeBridge.agentAttach(nativeId,id,row.meta.id)
    restored.delete(id)
    if (!subscriptions.has(id)) await subscribeRemoteAgent(id)
    await refreshAgentThread(id)
  })().finally(() => attaching.delete(id))
  attaching.set(id,task)
  return task
}
export async function refreshAgentCommands(id: string, load: () => Promise<AgentCatalog>) {
  const catalog = await load(), row = rows.get(id)
  if (row) { row.commands = catalog.commands; emit() }
  return catalog
}
export function subscribeRemoteAgent(id: string): Promise<void> {
  if (restored.has(id)) return Promise.resolve()
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
        row.state = row.persistent ? "detached" : "submissionUnknown"
        if (!row.persistent) { row.pendingPermission = undefined; row.pendingInput = undefined; row.turnActive = false }
        row.lastError = restored.has(id) ? row.resumable ? "This conversation is saved. Select it to connect and continue." : "This thread belonged to a previous Still process. Its transcript is read-only; start a new thread." : error instanceof Error ? error.message : "Remote process is unavailable. Inspect the server before retrying."
        emit()
      }
    }
  })().finally(() => subscribing.delete(id))
  subscribing.set(id, task)
  return task
}
export async function sendAgentMessage(id: string, message: string, duringHistoryOperation = false) {
  const row = rows.get(id)
  if (!row || !["working", "complete", "cancelled"].includes(row.state) || row.turnActive || historyOperations.has(id) && !duringHistoryOperation) throw new Error("Agent is not ready for another prompt.")
  // Sequence numbers and the user message come from the native runner, not an optimistic counter.
  row.turnActive = true; row.lastError = undefined; emit()
  try { await nativeBridge.agentSend(id, message) }
  catch (error) {
    const current = rows.get(id)!
    current.state = "submissionUnknown"; current.turnActive = false
    current.meta = { ...current.meta, submissionUnknown: true }; persist(current)
    current.lastError = error instanceof Error ? error.message : "The prompt may have reached the server. Inspect it before retrying."
    emit(); throw error
  }
}
export async function respondAgentPermission(id: string, requestId: string | number, optionId: string) {
  const row = rows.get(id)
  if (!row?.pendingPermission || row.pendingPermission.requestId !== requestId || !row.pendingPermission.options.some(option => option.optionId === optionId)) throw new Error("This permission is stale. Refresh the agent thread.")
  await respondToRequest(id, "permission", requestId, () => nativeBridge.agentRespondPermission(id, requestId, optionId))
}
export async function respondAgentInput(id: string, requestId: string | number, answers: Record<string, unknown> | null) {
  const row = rows.get(id)
  if (!row?.pendingInput || row.pendingInput.requestId !== requestId) throw new Error("This question is stale. Refresh the agent thread.")
  await respondToRequest(id, "question", requestId, () => nativeBridge.agentRespondInput(id, requestId, answers))
}
async function respondToRequest(id: string, kind: "question" | "permission", requestId: string | number, send: () => Promise<void>) {
  const key = JSON.stringify([id, kind, requestId])
  const row = rows.get(id)
  if (!row || restored.has(id) || ["saved", "error", "submissionUnknown", "rewinding"].includes(row.state)) throw new Error("Reconnect and refresh this request before responding.")
  if (requestOperations.has(key)) return
  if (unconfirmedRequests.has(key)) throw new Error("Delivery was not confirmed. Check request status before responding again.")
  requestOperations.add(key)
  try {
    await send()
    await refreshAgentThread(id)
  } catch (failure) {
    unconfirmedRequests.add(key)
    try { await refreshAgentThread(id) } catch {}
    const message = failure && typeof failure === "object" && "message" in failure ? String(failure.message) : String(failure)
    throw new Error(message)
  } finally { requestOperations.delete(key) }
}
export async function reconcileAgentRequest(id: string, kind: "question" | "permission", requestId: string | number) {
  await refreshAgentThread(id)
  const row = rows.get(id)
  if (!row || ["error", "submissionUnknown", "saved"].includes(row.state)) throw new Error("The agent is unavailable. Reconnect before retrying this request.")
  unconfirmedRequests.delete(JSON.stringify([id, kind, requestId]))
}
export function cancelAgentTurn(id: string) { return nativeBridge.agentCancel(id) }
export async function startRemoteAgent(nativeId: string, localId: string, agentId: string, options?: AgentLaunchOptions, owner?: Session, onCreated?: (row: AgentThreadRow) => void) {
  if (!nativeId) throw new Error("Connect to this server in Still and verify its host key first.")
  await loadAgentThreads()
  const current = await nativeBridge.agentStart(nativeId, localId, agentId, options)
  const previous = options?.conversationId ? [...rows.values()].find(row => row.meta.id === options.conversationId) : undefined
  if (previous) {
    rows.delete(previous.executionId); restored.delete(previous.executionId); tombstones.add(previous.executionId)
    subscriptions.get(previous.executionId)?.(); subscriptions.delete(previous.executionId)
  }
  rows.set(current.executionId, { ...current, meta: previous?.meta || metadata(current), previousTranscript: previous?.transcript, transcript: [...(previous?.transcript || []), ...current.transcript], touchedAt: Date.now() }); emit()
  // Failed startup still belongs to its server/folder and remains inspectable.
  if (owner) { rows.get(current.executionId)!.meta.hostKey = hostKey(owner); persist(rows.get(current.executionId)); emit() }
  onCreated?.(rows.get(current.executionId)!)
  await subscribeRemoteAgent(current.executionId)
  if (rows.get(current.executionId)?.state === "connecting") await waitForAgentReady(current.executionId)
  await refreshAgentThread(current.executionId)
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
  row.meta = { ...row.meta, ...patch, id: row.meta.id }; persist(row); emit()
}
export function clearAgentDraft(id: string, submitted: string) {
  const row = rows.get(id)
  if (row?.meta.draft.trim() === submitted.trim()) updateThreadMeta(id, { draft: "" })
}
export async function deleteAgentThread(id: string) {
  const row = rows.get(id)
  if (!row) return
  if (row.turnActive || row.state === "rewinding" || historyOperations.has(id)) throw new Error("Wait for the current operation before deleting this conversation.")
  if (!restored.has(id)) await nativeBridge.agentClose(id)
  await flushAgentSaves()
  await nativeBridge.agentDeleteSaved(row.meta.id)
  discardAgentSave(row.meta.id)
  tombstones.add(id); rows.delete(id); restored.delete(id)
  subscriptions.get(id)?.(); subscriptions.delete(id)
  emit()
}
export async function discardPreparedAgent(id: string) {
  const row = rows.get(id)
  if (row?.meta.prepared && !row.meta.draft && !row.transcript.some(event => event.type === "userMessage")) {
    try { await deleteAgentThread(id) }
    catch (error) { updateThreadMeta(id, { prepared: false }); throw error }
  }
}
export function canResumeAgentThread(row: AgentThreadRow) {
  return row.state !== "submissionUnknown" && row.state !== "rewinding" && !historyOperations.has(row.executionId) && !row.meta.submissionUnknown && !!row.resumable && !!row.agentSessionId && !row.turnActive && !row.pendingInput && !row.pendingPermission && (restored.has(row.executionId) || row.state === "error")
}
export async function resumeAgentThread(id: string, start: (agent: string, options: AgentLaunchOptions) => Promise<AgentThreadRow>, executable?: string) {
  const row = rows.get(id)
  if (!row || !canResumeAgentThread(row)) throw new Error("Refresh this conversation before resuming. An uncertain or active execution cannot be replaced safely.")
  if (!restored.has(id)) await nativeBridge.agentClose(id)
  await flushAgentSaves()
  const next = await start(row.agentId, { cwd: row.cwd, resumeSessionId: row.agentSessionId, conversationId: row.meta.id, executable })
  if (!idleState(next)) throw new Error(next.lastError || "The saved agent session could not be resumed.")
  if (!next.previousTranscript) { next.previousTranscript = row.transcript; next.transcript = [...row.transcript, ...next.transcript] }
  tombstones.add(id); rows.delete(id); restored.delete(id)
  subscriptions.get(id)?.(); subscriptions.delete(id)
  persist(next); emit(); return next
}
const idleState = (row: AgentThreadRow) => ["working", "complete", "cancelled"].includes(row.state) && !row.turnActive
export function canChangeAgentHistory(row: AgentThreadRow, messageId: string, retry = false) {
  return !!row.historyCapabilities?.[retry ? "retry" : "revert"] && !restored.has(row.executionId) && !historyOperations.has(row.executionId)
    && !row.turnActive && !row.pendingInput && !row.pendingPermission && !row.meta.submissionUnknown && !row.meta.archivedAt
    && ["working", "complete", "cancelled", "error"].includes(row.state)
    && row.transcript.some(event => event.type === "userMessage" && event.messageId === messageId && !!event.checkpoint)
}
export async function changeAgentHistory(id: string, messageId: string, retry: boolean) {
  const row = rows.get(id)
  if (!row || !canChangeAgentHistory(row, messageId, retry)) throw new Error("Restore this conversation and wait until it is idle before changing its messages.")
  const message = row.transcript.find(event => event.type === "userMessage" && event.messageId === messageId)!
  const existingDraft = row.meta.draft
  historyOperations.add(id)
  const sequence = row.lastSequence
  row.state = "rewinding"; emit()
  try {
    await nativeBridge.agentRevert(id, messageId, sequence)
    await refreshAgentThread(id)
    const current = rows.get(id)
    const restoredDraft = current && !existingDraft.trim() && !current.meta.draft.trim()
    if (restoredDraft) updateThreadMeta(id, { draft: message.text || "" })
    if (retry) {
      await sendAgentMessage(id, message.text || "", true)
      if (restoredDraft) clearAgentDraft(id, message.text || "")
    }
  } catch (error) {
    try { await refreshAgentThread(id) } catch {
      const current = rows.get(id)
      if (current) { current.state = "submissionUnknown"; current.lastError = "The history change was not confirmed. Inspect the provider session before continuing."; current.meta = { ...current.meta, submissionUnknown: true }; persist(current) }
    }
    throw error
  } finally { historyOperations.delete(id); emit() }
}
export async function setAgentConfig(id: string, configId: string, value: string | boolean) {
  const row = rows.get(id)
  if (!row || row.turnActive || historyOperations.has(id) || !["working", "complete", "cancelled"].includes(row.state)) throw new Error("Wait until the agent is idle before changing its settings.")
  if (configOperations.has(id)) throw new Error("Wait for the previous setting update.")
  configOperations.add(id)
  try { await nativeBridge.agentSetConfig(id, configId, value); await refreshAgentThread(id) }
  finally { configOperations.delete(id) }
}
const configOperations = new Set<string>()
