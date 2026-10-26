import { useSyncExternalStore } from "react"
import { nativeBridge, type Unsubscribe } from "../bridge/nativeBridge"
import type { AgentLaunchOptions, AgentThreadEvent, AgentThreadSnapshot } from "../agents/types"

export type AgentThreadRow = AgentThreadSnapshot & { touchedAt: number }
const rows = new Map<string, AgentThreadRow>()
const listeners = new Set<() => void>()
const subscriptions = new Map<string, Unsubscribe>()
const subscribing = new Map<string, Promise<void>>()
const restored = new Set<string>()
let version = 0
const emit = () => { version++; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const snapshotVersion = () => version
export function useAgentThreads(): AgentThreadRow[] {
  useSyncExternalStore(subscribe, snapshotVersion, snapshotVersion)
  return [...rows.values()].sort((a, b) => b.touchedAt - a.touchedAt)
}
function persist() {
  try {
    const data = [...rows.values()].sort((a, b) => b.touchedAt - a.touchedAt).slice(0, 80)
      .map(row => ({ ...row, transcript: row.transcript.slice(-500) }))
    localStorage.setItem("still.agents.index.v1", JSON.stringify(data))
  } catch { /* Cache is optional; the native process remains authoritative. */ }
}
function restore() {
  try {
    const data: unknown = JSON.parse(localStorage.getItem("still.agents.index.v1") || "[]")
    if (!Array.isArray(data)) return
    for (const row of data.slice(0, 80)) {
      if (!row || typeof row.executionId !== "string" || typeof row.localSessionId !== "string" || !Array.isArray(row.transcript)) continue
      rows.set(row.executionId, { ...row, configOptions: Array.isArray(row.configOptions) ? row.configOptions : [],
        state: "error", turnActive: false, pendingPermission: undefined,
        lastError: "This thread belonged to a previous Still process. Its transcript is read-only; start a new thread." })
      restored.add(row.executionId)
    }
  } catch { /* Ignore corrupt or unavailable local cache. */ }
}
restore()
function receive(row: AgentThreadRow, event: AgentThreadEvent) {
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= row.lastSequence) return
  row.lastSequence = event.sequence
  row.touchedAt = Date.now()
  if (event.type === "userMessage") { row.turnActive = true; row.lastError = undefined }
  if (event.type === "threadState" && event.state) {
    row.state = event.state
    if (event.state === "working") row.pendingPermission = undefined
  }
  if (event.type === "permission" && event.permission) { row.pendingPermission = event.permission; row.state = "inputRequired" }
  if (event.type === "threadComplete") { row.pendingPermission = undefined; row.turnActive = false; row.state = event.state || "complete"; row.lastError = undefined }
  if (event.type === "threadStopped") { row.pendingPermission = undefined; row.turnActive = true; row.state = "working"; row.lastError = event.text || "Waiting for remote cancellation confirmation." }
  if (event.type === "configOptions" && event.configOptions) row.configOptions = event.configOptions
  if (event.type === "commands" && event.commands) row.commands = event.commands
  if (event.type === "threadError") { row.pendingPermission = undefined; row.turnActive = false; row.state = "error"; row.lastError = event.text || "Remote agent error." }
  const last = row.transcript[row.transcript.length - 1]
  if ((event.type === "assistantChunk" || event.type === "reasoningChunk") && last?.type === event.type) {
    row.transcript = [...row.transcript.slice(0, -1), { ...last, sequence: event.sequence, text: (last.text || "") + (event.text || "") }]
  } else row.transcript = [...row.transcript, event].slice(-1200)
  // Streaming chunks need not synchronously serialize the whole history every token.
  if (event.type !== "assistantChunk" && event.type !== "reasoningChunk") persist()
  emit()
}
export async function refreshAgentThread(id: string) {
  const current = await nativeBridge.agentSnapshot(id)
  if (!current || typeof current.executionId !== "string") throw new Error("This remote agent process is no longer available.")
  const old = rows.get(id)
  // A newer live event can arrive while the snapshot request is in flight.
  if (!old || current.lastSequence >= old.lastSequence) rows.set(id, { ...current, touchedAt: old?.touchedAt || Date.now() })
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
        row.state = "submissionUnknown"; row.pendingPermission = undefined; row.turnActive = false
        row.lastError = restored.has(id) ? "This thread belonged to a previous Still process. Its transcript is read-only; start a new thread." : error instanceof Error ? error.message : "Remote process is unavailable. Inspect the server before retrying."
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
export async function startRemoteAgent(nativeId: string, localId: string, agentId: string, options?: AgentLaunchOptions) {
  if (!nativeId) throw new Error("Connect to this server in Still and verify its host key first.")
  const current = await nativeBridge.agentStart(nativeId, localId, agentId, options)
  rows.set(current.executionId, { ...current, touchedAt: Date.now() }); persist(); emit()
  await subscribeRemoteAgent(current.executionId)
  return rows.get(current.executionId)!
}
export async function setAgentConfig(id: string, configId: string, value: string | boolean) {
  const row = rows.get(id)
  if (!row || row.turnActive || !["working", "complete", "cancelled"].includes(row.state)) throw new Error("Wait until the agent is idle before changing its settings.")
  await nativeBridge.agentSetConfig(id, configId, value)
  await refreshAgentThread(id)
}
