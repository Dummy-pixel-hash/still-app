import { useSyncExternalStore } from "react"
import { nativeBridge, type Unsubscribe } from "../bridge/nativeBridge"
import type { AgentCapabilityReport, AgentCatalog, AgentChangeIndexItem, AgentChangeHistory, AgentHistoryPage, AgentLaunchOptions, AgentThreadEvent, AgentThreadSnapshot, LegacyAgentRecord, SharedConversation, SharedOperation, SharedProject } from "../agents/types"
import { hostKey, normalizeFolder, sharedAccount, type AgentProject, type ConversationMeta } from "../agents/workspace"
import { reconcileTodos, restoreTodos, todoStaleReason } from "../agents/todos"
import type { Session } from "../types"
import { discardAgentSave, flushAgentSaves, initializeAgentStorage, saveAgentWorkspace, scheduleAgentSave, storedWorkspace, storedWorkspaces, useAgentStorage } from "./agentStorage"

export type AgentThreadRow = AgentThreadSnapshot & { touchedAt: number; meta: ConversationMeta; previousTranscript?: AgentThreadEvent[]; historyLoading?: boolean; historyError?: string; historyTruncated?: boolean; historyAfter?: number | null; changeSummaries?: AgentChangeIndexItem[]; changeLoading?: boolean; changeError?: string; changeRevision?: number }
const rows = new Map<string, AgentThreadRow>()
const listeners = new Set<() => void>()
const subscriptions = new Map<string, Unsubscribe>()
const subscribing = new Map<string, Promise<void>>()
const restored = new Set<string>()
const tombstones = new Set<string>()
const historyOperations = new Set<string>()
const resumeOperations = new Set<string>()
const requestOperations = new Set<string>()
const unconfirmedRequests = new Set<string>()
const todoRefreshRevisions = new Map<string, number>()
const INDEX_KEY = "still.agents.index.v2"
const HISTORY_EVENTS = 200, HISTORY_CHARS = 512 * 1024, WINDOW_EVENTS = 400, WINDOW_CHARS = 1024 * 1024, EVENT_CHARS = 32 * 1024
const eventSizes = new WeakMap<AgentThreadEvent, number>()
const eventSize = (event: AgentThreadEvent) => {
  let size = eventSizes.get(event)
  if (size === undefined) { size = JSON.stringify(event).length; eventSizes.set(event, size) }
  return size
}
export function boundedTranscript(events: AgentThreadEvent[]) {
  let chars = 0, start = events.length
  for (let index = events.length - 1; index >= Math.max(0, events.length - HISTORY_EVENTS); index--) {
    const size = eventSize(events[index])
    if (chars + size > HISTORY_CHARS) break
    chars += size; start = index
  }
  return start ? events.slice(start) : events
}
function boundedHistoryWindow(events: AgentThreadEvent[], direction: "older" | "newer") {
  let chars = 0, start = 0, end = events.length
  if (direction === "older") {
    for (let index = 0; index < Math.min(events.length, WINDOW_EVENTS); index++) {
      const size = eventSize(events[index])
      if (chars + size > WINDOW_CHARS) break
      chars += size; end = index + 1
    }
  } else {
    start = events.length
    for (let index = events.length - 1; index >= Math.max(0, events.length - WINDOW_EVENTS); index--) {
      const size = eventSize(events[index])
      if (chars + size > WINDOW_CHARS) break
      chars += size; start = index
    }
  }
  return events.slice(start, end)
}
function boundRowTranscript(row: AgentThreadRow) {
  const bounded = boundedTranscript(row.transcript)
  if (bounded !== row.transcript) {
    row.historyTruncated = true
    const dropped = row.transcript.length - bounded.length
    if (row.historyLoaded === true) row.historyBefore = (typeof row.historyBefore === "number" ? row.historyBefore : 0) + dropped
  }
  row.transcript = bounded
  if (row.previousTranscript) {
    const retained = new Set(bounded)
    row.previousTranscript = row.previousTranscript.filter(event => retained.has(event))
  }
}
const historyLoads = new Map<string, Promise<void>>()
const historyRevisions = new Map<string, number>()
export function loadAgentHistory(id: string, before?: number, after?: number): Promise<void> {
  const pending = historyLoads.get(id)
  if (pending) return pending
  const row = rows.get(id)
  if (!row) return Promise.resolve()
  if (before === undefined && after === undefined && row.historyLoaded === true) return Promise.resolve()
  const revision = historyRevisions.get(id) || 0
  row.historyLoading = true; row.historyError = ""; emit()
  const task = (async () => {
    try {
      const page = before === undefined && after === undefined
        ? await nativeBridge.agentHistory(row.meta.id)
        : await nativeBridge.agentHistoryWindow(row.meta.id, before, after)
      const current = rows.get(id)
      if (!current || current.meta.id !== row.meta.id) return
      if ((historyRevisions.get(id) || 0) !== revision) return
      if (page.executionId !== id) throw new Error("Saved history belongs to a different execution. Refresh this conversation.")
      if (before !== undefined || after !== undefined) {
        const events = withoutObservationEvents(page.transcript)
        const older = before !== undefined
        const merged = older ? [...events, ...current.transcript] : [...current.transcript, ...events]
        const bounded = boundedHistoryWindow(merged, older ? "older" : "newer")
        const dropped = merged.length - bounded.length
        current.transcript = bounded
        if (older) {
          current.historyBefore = page.before
          if (dropped) current.historyAfter = Math.max(0, (current.historyAfter ?? page.total) - dropped)
        } else {
          current.historyBefore = typeof current.historyBefore === "number" ? current.historyBefore + dropped : page.before
          current.historyAfter = page.after
        }
        current.historyTruncated = !!current.historyBefore || !!current.historyAfter
      } else {
        // A disk read cannot roll back events received while it was in flight.
        if (page.lastSequence >= current.lastSequence || !current.transcript.length) {
          current.transcript = boundedTranscript(withoutObservationEvents(page.transcript))
          current.previousTranscript = current.transcript.filter(event => event.attemptId && event.attemptId !== id)
        }
        current.historyLoaded = true; current.historyBefore = page.before; current.historyAfter = page.after; current.historyTruncated = !!page.before
      }
    } catch (error) { const current = rows.get(id); if (current) current.historyError = `Saved activity could not be loaded: ${error instanceof Error ? error.message : String(error)}`; throw error }
    finally { const current = rows.get(id); if (current) current.historyLoading = false; emit() }
  })().finally(() => historyLoads.delete(id))
  historyLoads.set(id, task)
  return task
}
export async function loadEarlierAgentHistory(id: string) {
  const row = rows.get(id)
  if (!row || typeof row.historyBefore !== "number" || row.historyLoading) return
  await loadAgentHistory(id, row.historyBefore)
}
export async function loadLaterAgentHistory(id: string) {
  const row = rows.get(id)
  if (!row || typeof row.historyAfter !== "number" || row.historyLoading) return
  await loadAgentHistory(id, undefined, row.historyAfter)
}
export async function loadAgentChangeHistory(id: string) {
  const row = rows.get(id)
  if (!row || row.changeLoading) return
  const revision = row.changeRevision || 0
  row.changeLoading = true; row.changeError = undefined; emit()
  try {
    const result: AgentChangeHistory = await nativeBridge.agentChangeHistory(row.meta.id)
    if (result.executionId === id && rows.get(id) === row && (row.changeRevision || 0) === revision) {
      const merged = new Map(result.changes.map(item => [`${item.toolCallId}:${item.path}`, item]))
      for (const item of row.changeSummaries || []) merged.set(`${item.toolCallId}:${item.path}`, item)
      row.changeSummaries = [...merged.values()].slice(-200)
    }
  } catch (error) {
    if (rows.get(id) === row) row.changeError = error instanceof Error ? error.message : String(error)
  } finally {
    row.changeLoading = false
    emit()
    if ((row.changeRevision || 0) !== revision) void loadAgentChangeHistory(id)
  }
}
function updateChangeSummaries(row: AgentThreadRow, event: AgentThreadEvent) {
  if (event.type === "historyReverted") { row.changeSummaries = []; return }
  if (event.type !== "toolStart" && event.type !== "toolUpdate") return
  const summaries = row.changeSummaries || (row.changeSummaries = [])
  const id = event.toolCallId || `${event.attemptId || row.executionId}:${event.sequence}`
  const paths = new Set<string>()
  for (const item of event.content || []) if ((item.type === "diff" || item.type === "patch") && "path" in item && item.path) paths.add(item.path)
  const input = event.rawInput as Record<string, unknown> | undefined
  const output = event.rawOutput && typeof event.rawOutput === "object" ? event.rawOutput as Record<string, unknown> : undefined
  const path = [input?.path, input?.filePath, input?.file_path, event.locations?.[0]?.path].find(value => typeof value === "string" && value)
  const patch = [input?.patch, input?.patchText, output?.diff].find(value => typeof value === "string") as string | undefined
  if (patch) {
    for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+?)\r?$/gm)) paths.add(match[1])
    for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+?)\r?$/gm)) paths.add(match[2])
  }
  const editTool = event.toolKind === "edit" || /edit|write|apply.?patch|replace/i.test(event.title || "")
  if (editTool && typeof path === "string") paths.add(path)
  const status = event.status || ""
  const outcome: AgentChangeIndexItem["outcome"] = ["completed", "complete", "success"].includes(status) ? "completed"
    : ["failed", "error", "cancelled", "canceled", "rejected", "denied"].includes(status) ? "failed"
      : ["pending", "in_progress", "running", "queued"].includes(status) ? "pending" : "unconfirmed"
  const remembered = summaries.filter(item => item.toolCallId === id).map(item => item.path)
  const affected = paths.size ? [...paths] : remembered
  for (const affectedPath of affected) {
    const item = { id: `${id}:${affectedPath}`, path: affectedPath, toolCallId: id, outcome }
    const previous = summaries.findIndex(entry => entry.toolCallId === id && entry.path === affectedPath)
    if (previous >= 0) summaries[previous] = item
    else summaries.push(item)
  }
  if (summaries.length > 200) summaries.splice(0, summaries.length - 200)
}
function metadata(row: AgentThreadSnapshot & { meta?: ConversationMeta; touchedAt?: number }): ConversationMeta {
  const defaults = { id: row.conversationId || row.executionId, hostKey: row.hostKey || "", folder: normalizeFolder(row.cwd), title: "", pinned: false, createdAt: row.touchedAt || Date.now(), activityAt: row.touchedAt || Date.now(), order: row.touchedAt || Date.now(), draft: "", ...(row.parentConversationId ? { parentConversationId: row.parentConversationId } : {}) }
  if (!row.meta || typeof row.meta !== "object") return defaults
  const title = typeof row.meta.title === "string" ? row.meta.title : ""
  const firstPromptTitle = row.transcript?.find(event => event.type === "userMessage")?.text?.split("\n")[0].slice(0, 160)
  const titleSource = row.meta.titleSource || (title && title !== firstPromptTitle ? "user" : undefined)
  const pendingConfig = row.meta.pendingConfig && typeof row.meta.pendingConfig === "object" && !Array.isArray(row.meta.pendingConfig)
    ? Object.fromEntries(Object.entries(row.meta.pendingConfig).filter(([id, value]) => typeof id === "string" && id.length > 0 && id.length <= 160 && !/[\p{Cc}]/u.test(id) && (typeof value === "boolean" || typeof value === "string" && value.length <= 4096 && !/[\p{Cc}]/u.test(value))).slice(0, 16)) as Record<string, string | boolean>
    : undefined
  return { ...defaults, ...row.meta, id: typeof row.meta.id === "string" ? row.meta.id : defaults.id, hostKey: typeof row.meta.hostKey === "string" ? row.meta.hostKey : "", title, ...(titleSource ? { titleSource } : {}), folder: typeof row.meta.folder === "string" ? row.meta.folder : defaults.folder, draft: typeof row.meta.draft === "string" ? row.meta.draft : "", pendingConfig }
}
function withoutObservationEvents(events: AgentThreadEvent[]) { return events.filter(event => event.type !== "capabilities" && event.type !== "todos") }
function invalidateObservations(row: AgentThreadRow) {
  if (row.capabilities?.freshness === "current") row.capabilities = { ...row.capabilities, freshness: "stale" }
  if (row.todos && (!row.todoSync || row.todoSync.state === "current")) row.todoSync = { state: "stale", reason: todoStaleReason }
}
function scheduleTodoReconciliation(id: string, revision?: number) {
  if (revision === undefined) return
  if ((todoRefreshRevisions.get(id) ?? -1) >= revision) return
  // Accepted revisions never decrease, so a watermark is enough to deduplicate
  // the lifetime of this execution without retaining every revision forever.
  todoRefreshRevisions.set(id, revision)
  void refreshAgentThread(id).catch(() => { /* Keep the readable conflict; no automatic retry loop. */ })
}
function matchesCapabilityScope(row: Pick<AgentThreadSnapshot, "executionId" | "agentSessionId" | "cwd">, report?: AgentCapabilityReport): report is AgentCapabilityReport {
  return !!report && report.schemaVersion === 1 && report.executionId === row.executionId && report.agentSessionId === row.agentSessionId
    && report.cwd === row.cwd && Number.isSafeInteger(report.configGeneration) && report.configGeneration >= 0
    && (report.freshness === "current" || report.freshness === "stale")
}
function mergeCapabilities(scope: AgentThreadSnapshot, previous?: AgentCapabilityReport, incoming?: AgentCapabilityReport, staleIfMissing = false) {
  const old = matchesCapabilityScope(scope, previous) ? previous : undefined
  if (!incoming) return old && staleIfMissing ? { ...old, freshness: "stale" as const } : old
  if (!matchesCapabilityScope(scope, incoming)) return old
  if (old && incoming.configGeneration < old.configGeneration) return old
  return incoming
}
function restoredCapabilities(row: AgentThreadSnapshot) {
  const report = mergeCapabilities(row, undefined, row.capabilities)
  return report ? { ...report, freshness: "stale" as const } : undefined
}
let version = 0
const emit = () => { version++; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const snapshotVersion = () => version
export function useAgentThreads(): AgentThreadRow[] {
  useSyncExternalStore(subscribe, snapshotVersion, snapshotVersion)
  return [...rows.values()].filter(row => !row.meta.sharedDeleted || row.meta.draft.trim() || row.meta.draftAttachments?.length).sort((a, b) => b.touchedAt - a.touchedAt)
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
      const transcript = withoutObservationEvents(row.transcript)
      const firstCurrent = transcript.findIndex(event => event.attemptId === row.executionId)
      const previousCount = firstCurrent > 0 ? firstCurrent : row.previousEventCount ? withoutObservationEvents(row.transcript.slice(0, row.previousEventCount)).length : firstCurrent < 0 && transcript.some(event => event.attemptId) ? transcript.length : 0
      rows.set(row.executionId, { ...row, meta: metadata(row), configOptions: Array.isArray(row.configOptions) ? row.configOptions : [],
        ...restoreTodos(row.todos, row.todoSync), capabilities: restoredCapabilities(row), transcript,
        previousTranscript: previousCount ? transcript.slice(0, previousCount) : undefined,
        state: row.state === "submissionUnknown" || row.state === "rewinding" || row.meta?.submissionUnknown || row.recoveryRequired ? "submissionUnknown" : row.recoveryReason ? "error" : "saved", turnActive: false, pendingPermission: undefined, pendingInput: undefined, lastError: row.state === "submissionUnknown" || row.state === "rewinding" || row.meta?.submissionUnknown || row.recoveryRequired ? row.lastError || "The last operation was not confirmed. Inspect the provider session before continuing." : row.recoveryReason ? row.lastError || "The server-side worker is no longer available. Resume the saved provider session; no prompt has been resent." : undefined })
      boundRowTranscript(rows.get(row.executionId)!)
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

export interface AgentLibrarySyncResult { conversations: number; warnings: string[]; legacyRecords: LegacyAgentRecord[] }
export interface AgentLibrarySyncStatus { message: string; failed: boolean; warnings: string[]; legacyRecords: LegacyAgentRecord[] }
type LibrarySyncListener = (status: AgentLibrarySyncStatus) => void
const remoteLibrarySyncs = new Map<string, Promise<AgentLibrarySyncResult>>()
const libraryWatchers = new Map<string, { stop: () => void; listeners: Set<LibrarySyncListener>; status?: AgentLibrarySyncStatus }>()
/** A foreground account sync survives navigation and hiding its status panel.
 * It never authenticates, starts a model, or reconnects a closed SSH session. */
export function watchRemoteAgentLibrary(nativeId: string, listener: LibrarySyncListener): Unsubscribe {
  let watcher = libraryWatchers.get(nativeId)
  if (!watcher) {
    const listeners = new Set<LibrarySyncListener>()
    let stopped = false, unsubscribe: Unsubscribe | undefined
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return
      void syncRemoteAgentLibrary(nativeId).then(result => {
        const message = result.warnings.length ? `Conversations synced. ${result.warnings.length} record${result.warnings.length === 1 ? " needs" : "s need"} review.` : "Conversations synced."
        publish({ message, failed: false, warnings: result.warnings, legacyRecords: result.legacyRecords })
      }).catch(error => publish({ message: error && typeof error === "object" && "message" in error ? String(error.message) : String(error), failed: true, warnings: [], legacyRecords: [] }))
    }
    const timer = setInterval(poll, 15000)
    document.addEventListener("visibilitychange", poll)
    const stop = () => {
      if (stopped) return
      stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", poll); unsubscribe?.()
      libraryWatchers.delete(nativeId)
      for (const [account, connection] of sharedConnections) if (connection.nativeId === nativeId) sharedConnections.delete(account)
    }
    const entry: NonNullable<ReturnType<typeof libraryWatchers.get>> = { stop, listeners }
    const publish = (status: AgentLibrarySyncStatus) => {
      if (stopped) return
      entry.status = status
      for (const callback of listeners) callback(status)
    }
    watcher = entry
    libraryWatchers.set(nativeId, watcher)
    void nativeBridge.subscribeToSession(nativeId, event => {
      if (event.type === "status" && ["closed", "error", "unconnected"].includes(event.status.toLowerCase())) {
        publish({ message: "This account is offline. Saved history and unfinished drafts remain on this device.", failed: true, warnings: [], legacyRecords: [] })
        stop()
      }
    }).then(value => { if (stopped) value(); else unsubscribe = value }).catch(() => { /* The bounded foreground poll remains available. */ })
    poll()
  }
  watcher.listeners.add(listener)
  if (watcher.status) listener(watcher.status)
  return () => { watcher?.listeners.delete(listener) }
}
export function stopRemoteAgentLibrary(nativeId: string) { libraryWatchers.get(nativeId)?.stop() }
const sharedConnections = new Map<string, { nativeId: string; host: string }>()
const sharedWrites = new Map<string, Promise<void>>()
const sharedFields = ["title", "pinned", "archivedAt", "order"] as const
function mergeSharedProjects(previous: SharedProject[], incoming: SharedProject[]) {
  const merged = new Map(previous.map(project => [project.id, project]))
  for (const project of incoming) if (!merged.has(project.id) || merged.get(project.id)!.revision <= project.revision) merged.set(project.id, project)
  return [...merged.values()]
}

function sharedProjection(row: AgentThreadRow, incoming: SharedConversation) {
  if (incoming.conversationId !== row.meta.id || incoming.executionId !== row.executionId) throw new Error("Shared metadata belongs to another execution.")
  if (row.meta.shared && row.meta.shared.serverAccountId !== incoming.serverAccountId) throw new Error("The server account identity changed. Your saved data was not replaced.")
  if (row.meta.shared && row.meta.shared.revision > incoming.revision) return
  const values = { ...incoming.values, archivedAt: incoming.values.archivedAt ?? undefined }
  if (!incoming.values.title.trim() && incoming.values.titleSource !== "user" && row.meta.title.trim()) {
    values.title = row.meta.title
    values.titleSource = row.meta.titleSource || "prompt"
  }
  row.meta = { ...row.meta, ...values, shared: incoming }
  if (row.meta.parentConversationId && typeof incoming.prepared === "boolean") row.meta.subagentPrepared = incoming.prepared
  if (incoming.deleted) {
    row.meta.sharedDeleted = true
    row.meta.sharedSyncError = "This conversation was deleted from the shared account. Any unfinished draft is retained on this device and cannot be sent to the deleted execution."
  }
  for (const operation of row.meta.sharedPending || []) {
    if (operation.kind === "organization.patch") row.meta = { ...row.meta, ...operation.patch,
      ...(operation.patch && Object.prototype.hasOwnProperty.call(operation.patch, "title") ? { titleSource: "user" as const } : {}),
      archivedAt: operation.patch && Object.prototype.hasOwnProperty.call(operation.patch, "archivedAt") ? operation.patch.archivedAt as number || undefined : row.meta.archivedAt }
  }
  if (row.meta.sharedLocalChanges) row.meta = { ...row.meta, ...row.meta.sharedLocalChanges,
    ...(typeof row.meta.sharedLocalChanges.title === "string" ? { titleSource: "user" as const } : {}),
    archivedAt: row.meta.sharedLocalChanges.archivedAt ?? row.meta.archivedAt }
}

function sharedScope(row: AgentThreadRow, kind: SharedOperation["kind"]): SharedOperation {
  const shared = row.meta.shared
  if (!shared) throw new Error("Sync this conversation’s account before sharing changes.")
  return { kind, operationId: crypto.randomUUID(), serverAccountId: shared.serverAccountId, expectedCatalogRevision: shared.catalogRevision,
    conversationId: row.meta.id, executionId: row.executionId, expectedGeneration: shared.generation, cwd: row.meta.folder }
}

/** Intents reach the native durable cache before their operation ID crosses SSH. */
export function flushSharedChanges(id: string): Promise<void> {
  if (sharedWrites.has(id)) return sharedWrites.get(id)!
  const work = (async () => {
    const row = rows.get(id)
    if (!row?.meta.shared || row.meta.sharedConflict) return
    const connection = sharedConnections.get(row.meta.shared.serverAccountId)
    if (!connection || connection.host !== row.meta.hostKey) return
    while (row.meta.sharedPending?.length) {
      if (sharedConnections.get(row.meta.shared.serverAccountId)?.nativeId !== connection.nativeId) return
      const operation = row.meta.sharedPending[0]
      if (operation.expectedGeneration !== row.meta.shared.generation) {
        row.meta.sharedConflict = true
        row.meta.sharedSyncError = "The execution was safely resumed on another device. Review your saved organization edit before applying it to the new generation."
        persist(row); emit(); return
      }
      try {
        await nativeBridge.agentSaveMetadata(row.meta.id, structuredClone(row.meta))
        const result = await nativeBridge.agentSharedOperation(connection.nativeId, operation)
        if (!result.ok) {
          if (result.current) sharedProjection(row, result.current)
          row.meta.sharedConflict = true
          row.meta.sharedSyncError = result.code === "revisionConflict" ? "Another device changed these fields. Your edit is saved here; review it before applying it again." : result.message || "This shared operation needs reconciliation before it can be retried."
          persist(row); emit(); return
        }
        row.meta.sharedPending = row.meta.sharedPending.filter(pending => pending.operationId !== operation.operationId)
        if (result.current) sharedProjection(row, result.current)
        row.meta.sharedSyncError = undefined
        row.meta.sharedConflict = false
        persist(row); emit()
      } catch (failure) {
        row.meta.sharedSyncError = failure && typeof failure === "object" && "message" in failure ? String(failure.message) : String(failure)
        persist(row); emit(); return
      }
    }
  })().finally(() => sharedWrites.delete(id))
  sharedWrites.set(id, work)
  return work
}

export function retrySharedChanges(id: string) {
  const row = rows.get(id)
  if (!row?.meta.shared) return Promise.resolve()
  if (row.meta.sharedConflict) {
    const desired = Object.assign({}, row.meta.sharedLocalChanges, ...(row.meta.sharedPending || []).filter(item => item.kind === "organization.patch").map(item => item.patch))
    row.meta.sharedPending = []
    row.meta.sharedLocalChanges = undefined
    row.meta.sharedAdoptionResolved = true
    row.meta.sharedConflict = false
    row.meta.sharedSyncError = undefined
    if (Object.keys(desired).length) updateThreadMeta(id, desired)
    else { persist(row); emit() }
  }
  return flushSharedChanges(id)
}

export function sharedUnread(row: AgentThreadRow) {
  return !!row.meta.shared && row.meta.shared.conversationSeq > row.meta.shared.readThroughSeq
}

export function markAgentThreadRead(id: string) {
  const row = rows.get(id), shared = row?.meta.shared
  if (!row || !shared || shared.executionId !== row.executionId || ["saved", "detached", "connecting"].includes(row.state) || row.meta.sharedDeleted) return
  const through = Math.min((shared.executionOffset || 0) + (row.remoteCursor || 0), shared.conversationSeq)
  const pending = Math.max(shared.readThroughSeq, ...(row.meta.sharedPending || []).filter(item => item.kind === "read.advance").map(item => item.readThroughSeq || 0))
  if (through <= pending) return
  row.meta.sharedPending = [...row.meta.sharedPending || [], { ...sharedScope(row, "read.advance"), readThroughSeq: through }]
  persist(row); emit(); void flushSharedChanges(id)
}

export async function updateSharedProject(project: AgentProject, patch: { name?: string; order?: number }): Promise<boolean> {
  const account = sharedAccount(project.host)
  const remote = account?.projects.find(item => item.cwd === project.folder)
  if (!account || !remote) return false
  const connection = sharedConnections.get(account.serverAccountId)
  const slot = `shared-project-intent:${account.serverAccountId}:${remote.id}`
  const pending = storedWorkspace(slot) as { input?: SharedOperation; conflict?: boolean } | undefined
  if (pending?.input && !pending.conflict && JSON.stringify(pending.input.patch) !== JSON.stringify(patch)) throw new Error("Retry or reconcile the previously saved project change before replacing it.")
  const input: SharedOperation = pending?.input && !pending.conflict ? pending.input : { kind: "project.patch", operationId: crypto.randomUUID(), serverAccountId: account.serverAccountId,
    expectedCatalogRevision: account.revision, cwd: project.folder, projectId: remote.id, expectedRevision: remote.revision, patch }
  // Project requests are persisted separately from device-only workspace/drafts.
  saveAgentWorkspace(slot, { input })
  await nativeBridge.agentSaveWorkspace(slot, { input })
  if (!connection || connection.host !== project.host) { emit(); return true }
  const result = await nativeBridge.agentSharedOperation(connection.nativeId, input)
  if (result.project) {
    saveAgentWorkspace(`shared-account:${project.host}`, { ...account, revision: Math.max(account.revision, result.project.revision), projects: mergeSharedProjects(account.projects, [result.project]) })
    emit()
  }
  const receipt = result.ok ? { resolved: true } : { input, conflict: true }
  saveAgentWorkspace(slot, receipt)
  await nativeBridge.agentSaveWorkspace(slot, receipt)
  if (!result.ok) throw new Error("Another device changed this project. Your typed name is retained; review the new value before trying again.")
  return true
}

export async function reorderSharedProjects(host: string, desired: AgentProject[]): Promise<boolean> {
  const account = sharedAccount(host)
  if (!account) return false
  const connection = sharedConnections.get(account.serverAccountId)
  const selected = desired.filter(project => project.host === host).map(project => account.projects.find(item => item.cwd === project.folder)).filter((value): value is SharedProject => !!value)
  const order = [...selected, ...account.projects.filter(project => !project.deleted && !selected.some(item => item.id === project.id))]
  const slot = `shared-project-order:${account.serverAccountId}`
  const pending = storedWorkspace(slot) as { input?: SharedOperation; conflict?: boolean } | undefined
  if (pending?.input && !pending.conflict && JSON.stringify(pending.input.order?.map(item => item.id)) !== JSON.stringify(order.map(item => item.id))) throw new Error("Retry the previously saved account ordering before replacing it.")
  const input: SharedOperation = pending?.input && !pending.conflict ? pending.input : { kind: "project.reorder", operationId: crypto.randomUUID(),
    serverAccountId: account.serverAccountId, expectedCatalogRevision: account.revision, cwd: "/",
    order: order.map(project => ({ id: project.id, revision: project.revision })) }
  saveAgentWorkspace(slot, { input })
  await nativeBridge.agentSaveWorkspace(slot, { input })
  if (!connection || connection.host !== host) { emit(); return true }
  const result = await nativeBridge.agentSharedOperation(connection.nativeId, input)
  if (result.projects) {
    saveAgentWorkspace(`shared-account:${host}`, { ...account, projects: mergeSharedProjects(account.projects, result.projects),
      revision: Math.max(account.revision, ...result.projects.map(project => project.revision)) })
    emit()
  }
  const receipt = result.ok ? { resolved: true } : { input, conflict: true }
  saveAgentWorkspace(slot, receipt)
  await nativeBridge.agentSaveWorkspace(slot, receipt)
  if (!result.ok) throw new Error("Another device changed these projects. Their current order was kept; review it before retrying your move.")
  return true
}

export async function removeSharedProject(project: AgentProject): Promise<boolean> {
  const account = sharedAccount(project.host), remote = account?.projects.find(item => item.cwd === project.folder)
  if (!account || !remote) return false
  const connection = sharedConnections.get(account.serverAccountId)
  if (!connection || connection.host !== project.host) throw new Error("Reconnect this account before removing its shared project. No folder or history was deleted.")
  const slot = `shared-project-intent:${account.serverAccountId}:${remote.id}`
  const saved = storedWorkspace(slot) as { input?: SharedOperation; conflict?: boolean } | undefined
  if (saved?.input && saved.input.kind !== "project.delete") throw new Error("Reconcile this project's saved edit before removing it.")
  const input: SharedOperation = saved?.input && !saved.conflict ? saved.input : { kind: "project.delete", operationId: crypto.randomUUID(), serverAccountId: account.serverAccountId,
    expectedCatalogRevision: account.revision, cwd: project.folder, projectId: remote.id, expectedRevision: remote.revision }
  saveAgentWorkspace(slot, { input }); await nativeBridge.agentSaveWorkspace(slot, { input })
  const result = await nativeBridge.agentSharedOperation(connection.nativeId, input)
  if (result.project) saveAgentWorkspace(`shared-account:${project.host}`, { ...account, projects: mergeSharedProjects(account.projects, [result.project]) })
  const receipt = result.ok ? { resolved: true } : { input, conflict: true }
  saveAgentWorkspace(slot, receipt); await nativeBridge.agentSaveWorkspace(slot, receipt); emit()
  if (!result.ok) throw new Error("The shared project changed. Its current data was kept; refresh before trying again.")
  return true
}

async function reconcileSharedProjectIntents(accountId: string, host: string, nativeId: string) {
  for (const [slot, value] of Object.entries(storedWorkspaces())) {
    if (!slot.startsWith(`shared-project-intent:${accountId}:`) && slot !== `shared-project-order:${accountId}`) continue
    const pending = value as { input?: SharedOperation; conflict?: boolean }
    if (!pending.input) continue
    if (pending.conflict) throw new Error("A saved project organization edit conflicts with another device. Rename that project or repeat its move to review and apply your saved change.")
    const result = await nativeBridge.agentSharedOperation(nativeId, pending.input)
    const account = sharedAccount(host)
    if (account && (result.project || result.projects)) {
      const projects = mergeSharedProjects(account.projects, result.projects || [result.project!])
      saveAgentWorkspace(`shared-account:${host}`, { ...account, projects, revision: Math.max(account.revision, ...projects.map(project => project.revision)) })
      emit()
    }
    const receipt = result.ok ? { resolved: true } : { input: pending.input, conflict: true }
    saveAgentWorkspace(slot, receipt)
    await nativeBridge.agentSaveWorkspace(slot, receipt)
    if (!result.ok) throw new Error("Your saved project edit needs review. The other device's current organization was kept; your intended change remains saved here.")
  }
}
/** Import the account's remote execution identities without replacing a worker.
 * Discovery is independent of the selected conversation and preserves local drafts. */
export function syncRemoteAgentLibrary(nativeId: string): Promise<AgentLibrarySyncResult> {
  if (remoteLibrarySyncs.has(nativeId)) return remoteLibrarySyncs.get(nativeId)!
  const task = (async () => {
    await loadAgentThreads()
    let after: string | undefined
    const cursors = new Set<string>()
    const discovered = new Set<string>()
    const incoming = new Map<string, { shared?: SharedConversation; activityAt?: number }>()
    const deleted = new Set<string>()
    const warnings: string[] = []
    const legacyRecords = new Map<string, LegacyAgentRecord>()
    let account: { id: string; host: string; revision: number; projects: SharedProject[] } | undefined
    do {
      const page = await nativeBridge.agentRemoteLibrary(nativeId, after)
      for (const row of page.rows) { discovered.add(row.executionId); incoming.set(row.executionId, row) }
      warnings.push(...page.warnings || [])
      for (const record of page.legacyRecords || []) legacyRecords.set(record.executionId, record)
      for (const id of page.tombstones || []) deleted.add(id)
      if (page.catalogVersion === 1 && page.hostKey) {
        if (account && account.id !== page.serverAccountId) throw new Error("Remote account identity changed during pagination.")
        account = { id: page.serverAccountId, host: page.hostKey, revision: page.revision || 0, projects: page.projects || [] }
      }
      if (page.next && cursors.has(page.next)) throw new Error("Remote library returned a repeated page cursor.")
      if (page.next) cursors.add(page.next)
      after = page.next || undefined
    } while (after)
    const library = await nativeBridge.agentLibrary()
    for (const value of library.rows) {
      const saved = value as AgentThreadRow
      if (!discovered.has(saved.executionId) || tombstones.has(saved.executionId)) continue
      if (rows.has(saved.executionId)) {
        const current = rows.get(saved.executionId)!
        if (saved.agentSessionId) {
          if (current.agentSessionId && current.agentSessionId !== saved.agentSessionId) throw new Error("The saved provider session changed; the existing conversation and draft were kept.")
          current.agentSessionId = saved.agentSessionId
          if (saved.resumable) current.resumable = true
        }
        if (saved.meta.sharedLocalChanges) {
          current.meta.sharedLocalChanges = saved.meta.sharedLocalChanges
          current.meta.sharedConflict = true
          current.meta.sharedSyncError = saved.meta.sharedSyncError
        }
        continue
      }
      const previous = [...rows.values()].find(row => row.meta.id === saved.meta.id && row.executionId !== saved.executionId)
      if (previous) {
        if (!saved.meta.shared || saved.meta.shared.generation <= (previous.meta.shared?.generation || 0)) throw new Error("This execution needs explicit generation recovery; its original cache was kept.")
        subscriptions.get(previous.executionId)?.(); subscriptions.delete(previous.executionId)
        rows.delete(previous.executionId); restored.delete(previous.executionId); historyRevisions.delete(previous.executionId)
        todoRefreshRevisions.delete(previous.executionId)
        saved.meta = { ...saved.meta, draft: previous.meta.draft, draftAttachments: previous.meta.draftAttachments,
          sharedPending: previous.meta.sharedPending, sharedLocalChanges: previous.meta.sharedLocalChanges }
      }
      rows.set(saved.executionId, { ...saved, meta: metadata(saved), state: "saved", turnActive: false,
        transcript: boundedTranscript(withoutObservationEvents(saved.transcript || [])), historyLoaded: false, configOptions: saved.configOptions || [], touchedAt: saved.touchedAt || Date.now() })
      restored.add(saved.executionId)
    }
    if (account) {
      sharedConnections.set(account.id, { nativeId, host: account.host })
      const previous = sharedAccount(account.host)
      saveAgentWorkspace(`shared-account:${account.host}`, { serverAccountId: account.id, revision: Math.max(account.revision, previous?.revision || 0), projects: mergeSharedProjects(previous?.projects || [], account.projects) })
    }
    for (const [id, value] of incoming) {
      const row = rows.get(id)
      if (!row) continue
      if (value.shared) sharedProjection(row, value.shared)
      if (value.activityAt && Number.isFinite(value.activityAt)) row.meta.activityAt = value.shared ? value.activityAt : Math.max(row.meta.activityAt, value.activityAt)
    }
    if (account) for (const row of rows.values()) if (row.meta.shared?.serverAccountId === account.id && deleted.has(row.meta.id)) {
      row.meta.sharedDeleted = true
      row.meta.sharedSyncError = "Deleted from the shared account. Your local draft is retained but cannot be sent."
    }
    emit()
    // These new workers support non-destructive subscribers. Legacy sessions are
    // discoverable but remain read-only until an explicitly safe upgrade.
    const results = await Promise.allSettled([...discovered].filter(id => {
      const row = rows.get(id)
      return row?.continuity && !row.recoveryReason && (restored.has(id) || ["saved", "detached"].includes(row.state))
    }).map(id => reattachAgentThread(id, nativeId)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failures.length) throw new Error(`${failures.length} shared conversation${failures.length === 1 ? "" : "s"} could not catch up. Other conversations remain available. ${String(failures[0].reason?.message || failures[0].reason)}`)
    if (account) for (const row of rows.values()) if (row.meta.shared?.serverAccountId === account.id) await flushSharedChanges(row.executionId)
    if (account) await reconcileSharedProjectIntents(account.id, account.host, nativeId)
    return { conversations: discovered.size, warnings: [...new Set(warnings)], legacyRecords: [...legacyRecords.values()] }
  })().finally(() => remoteLibrarySyncs.delete(nativeId))
  remoteLibrarySyncs.set(nativeId, task)
  return task
}
function receive(row: AgentThreadRow, event: AgentThreadEvent) {
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= row.lastSequence) return
  if (event.attemptId && event.attemptId !== row.executionId) return
  if (event.type === "todos") {
    row.lastSequence = event.sequence
    if (event.remoteCursor !== undefined) row.remoteCursor = Math.max(row.remoteCursor || 0, event.remoteCursor)
    const merged = reconcileTodos(row.todos, row.todoSync, event.todos, event.todoSync, { stale: ["saved", "detached", "connecting"].includes(row.state) })
    if (JSON.stringify([row.todos, row.todoSync]) !== JSON.stringify([merged.todos, merged.todoSync])) {
      row.todos = merged.todos; row.todoSync = merged.todoSync; emit()
    }
    if (merged.refresh) scheduleTodoReconciliation(row.executionId, row.todos?.revision)
    return
  }
  if (event.type === "capabilities") {
    if (event.attemptId && event.attemptId !== row.executionId) return
    row.lastSequence = event.sequence
    if (event.remoteCursor !== undefined) row.remoteCursor = event.remoteCursor
    const capabilities = mergeCapabilities(row, row.capabilities, event.capabilities)
    if (capabilities && capabilities !== row.capabilities) { row.capabilities = capabilities; emit() }
    return
  }
  if (event.type === "chatTitle") {
    row.lastSequence = event.sequence
    if (event.title && row.meta.titleSource !== "user") {
      row.meta = { ...row.meta, title: event.title, titleSource: "agent" }
      persist(row); emit()
    }
    return
  }
  row.lastSequence = event.sequence
  if (event.remoteCursor !== undefined) row.remoteCursor = event.remoteCursor
  if (event.turnActive !== undefined) row.turnActive = event.turnActive
  if (event.recoveryReason) row.recoveryReason = event.recoveryReason
  if (["userMessage", "threadComplete", "permission", "input", "requestOutcome", "threadError"].includes(event.type)) { row.touchedAt = Date.now(); row.meta = { ...row.meta, activityAt: row.touchedAt } }
  if (event.type === "userMessage") { row.turnActive = true; row.lastError = undefined; row.meta.subagentPrepared = false; if (!row.meta.title) row.meta = { ...row.meta, title: event.text?.split("\n")[0].slice(0, 160) || "", titleSource: "prompt" } }
  if (event.type === "threadState" && event.state) {
    row.state = event.state
    if (["saved", "detached", "connecting"].includes(event.state)) invalidateObservations(row)
    if (event.state === "detached") row.lastError = event.text || "The agent continues on the server. Reconnecting to catch up."
    else if (event.state === "working" || event.state === "connecting") row.lastError = undefined
    if (event.state === "working" && event.turnActive && row.meta.submissionUnknown) row.meta = { ...row.meta, submissionUnknown: false }
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
    historyRevisions.set(row.executionId, (historyRevisions.get(row.executionId) || 0) + 1)
    row.historyLoaded = false; row.historyBefore = undefined; row.historyAfter = undefined; row.historyTruncated = true; row.changeSummaries = []; row.changeRevision = (row.changeRevision || 0) + 1
    row.transcript = revertHistory(row.transcript, event.messageId)
    if (row.previousTranscript) row.previousTranscript = revertHistory(row.previousTranscript, event.messageId)
    row.state = "working"; row.lastError = undefined; row.meta = { ...row.meta, submissionUnknown: false }
  }
  if (event.type === "commands" && event.commands) row.commands = event.commands
  if (event.type === "threadError") {
    invalidateObservations(row)
    row.pendingPermission = undefined; row.pendingInput = undefined
    row.turnActive = event.turnActive ?? false
    row.state = row.meta.submissionUnknown ? "submissionUnknown" : event.state || "error"; row.lastError = event.text || "Remote agent error."
    if (row.state === "submissionUnknown") row.meta = { ...row.meta, submissionUnknown: true }
  }
  updateChangeSummaries(row, event)
  // The native journal is authoritative while the rendered window is scrolled
  // into older history. Keep live status/change summaries up to date, but let
  // the next downward scroll fetch a contiguous page instead of splicing a new
  // event across an unloaded range.
  if (row.historyLoaded && typeof row.historyAfter === "number" && event.type !== "historyReverted") {
    if (["assistantChunk", "reasoningChunk", "toolUpdate"].includes(event.type)) scheduleRender()
    else emit()
    return
  }
  const last = row.transcript[row.transcript.length - 1]
  if ((event.type === "assistantChunk" || event.type === "reasoningChunk") && last?.type === event.type && last.messageId === event.messageId && last.attemptId === event.attemptId
    && (last.text?.length || 0) + (event.text?.length || 0) <= EVENT_CHARS / 2) {
    row.transcript = [...row.transcript.slice(0, -1), { ...last, endSequence: event.sequence, text: (last.text || "") + (event.text || "") }]
  } else row.transcript = [...row.transcript, event]
  boundRowTranscript(row)
  // Streaming chunks need not synchronously serialize the whole history every token.
  if (["userMessage", "threadComplete", "permission", "input", "requestOutcome", "threadError", "historyReverted"].includes(event.type)) persist(row)
  if (["assistantChunk", "reasoningChunk", "toolUpdate"].includes(event.type)) scheduleRender()
  else emit()
  if (event.type === "historyReverted") {
    const pending = historyLoads.get(row.executionId)
    if (pending) void pending.finally(() => { if (rows.get(row.executionId)?.historyLoaded === false) void loadAgentHistory(row.executionId).catch(() => {}) }).catch(() => {})
    else void loadAgentHistory(row.executionId).catch(() => {})
    void loadAgentChangeHistory(row.executionId)
  }
}
function revertHistory(events: AgentThreadEvent[], messageId?: string) {
  const index = messageId ? events.findIndex(event => event.type === "userMessage" && event.messageId === messageId) : -1
  return index < 0 ? events : events.slice(0, index)
}
function reconcileHistory(events: AgentThreadEvent[]) {
  let result: AgentThreadEvent[] = []
  for (const event of events) {
    if (event.type === "capabilities" || event.type === "todos") continue
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
  if (!current || current.executionId !== id) throw new Error("This remote agent process is no longer available.")
  const old = rows.get(id)
  if (old && (current.agentId !== old.agentId || current.cwd !== old.cwd
    || current.conversationId && old.conversationId && current.conversationId !== old.conversationId
    || current.hostKey && old.hostKey && current.hostKey !== old.hostKey)) {
    throw new Error("This snapshot belongs to another conversation, server, folder, or agent.")
  }
  // A newer live event can arrive while the snapshot request is in flight.
  if (tombstones.has(id)) return
  if (!old || current.lastSequence >= old.lastSequence) {
    const previous = old?.previousTranscript || []
    const live = old?.transcript.slice(previous.length) || []
    const currentTranscript = withoutObservationEvents(current.transcript)
    const first = currentTranscript[0]?.sequence
    const prefix = first === undefined ? live : live.filter(event => (event.endSequence || event.sequence) < first)
    const confirmedSharedState = current.continuity && !current.recoveryRequired && !current.pendingMessageId
    const unresolved = current.state === "submissionUnknown" || !confirmedSharedState && old?.meta.submissionUnknown && !current.turnActive && current.lastSequence <= old.lastSequence
    const transcript = activeHistory(reconcileHistory([...previous, ...prefix, ...currentTranscript]), current.activeMessageIds)
    const todos = reconcileTodos(old?.todos, old?.todoSync, current.todos, current.todoSync, { authoritative: true, stale: ["saved", "detached", "connecting"].includes(current.state) })
    rows.set(id, { ...current, todos: todos.todos, todoSync: todos.todoSync, capabilities: mergeCapabilities(current, old?.capabilities, current.capabilities, true), ...(unresolved ? { state: "submissionUnknown" as const, lastError: current.lastError || old?.lastError } : {}), previousTranscript: old?.previousTranscript ? transcript.filter(event => event.attemptId !== id) : undefined, transcript, meta: old?.meta ? { ...old.meta, submissionUnknown: !!unresolved } : metadata(current), touchedAt: old?.touchedAt || Date.now() })
    const next = rows.get(id)!
    next.historyLoaded = old?.historyLoaded
    next.historyBefore = old?.historyBefore
    next.historyAfter = old?.historyAfter
    next.historyLoading = old?.historyLoading
    next.historyError = old?.historyError
    next.historyTruncated = old?.historyTruncated
    next.changeSummaries = old?.changeSummaries
    next.changeLoading = old?.changeLoading
    next.changeError = old?.changeError
    next.changeRevision = old?.changeRevision
    boundRowTranscript(next)
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
    invalidateObservations(row); emit()
    const attached = await nativeBridge.agentAttach(nativeId,id,row.meta.id)
    if (attached.executionId !== id) throw new Error("The attached execution does not match this conversation.")
    // The handshake is not catch-up. Reconcile through the existing native
    // snapshot after subscribing, so a late handshake cannot replace live facts.
    restored.delete(id)
    if (!subscriptions.has(id)) await subscribeRemoteAgent(id)
    await refreshAgentThread(id)
    if (rows.get(id)?.state === "connecting") await waitForAgentReady(id)
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
        invalidateObservations(row)
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
export async function sendAgentMessage(id: string, message: string, duringHistoryOperation = false, options?: { messageId?: string; source?: "user" | "parentAgent"; config?: Array<{ configId: string; value: string | boolean }> }) {
  const row = rows.get(id)
  if (!row || row.meta.sharedDeleted || row.remoteImported && !row.continuity || row.recoveryReason || resumeOperations.has(id) || !["working", "complete", "cancelled", "error"].includes(row.state) || row.turnActive || row.meta.submissionUnknown || historyOperations.has(id) && !duringHistoryOperation) throw new Error("Agent is not ready for another prompt.")
  // Sequence numbers and the user message come from the native runner, not an optimistic counter.
  const sequenceBeforeSend = row.lastSequence
  row.turnActive = true; row.lastError = undefined; emit()
  try { await nativeBridge.agentSend(id, message, options) }
  catch (error) {
    const current = rows.get(id)
    if (!current) throw error
    if (error && typeof error === "object" && "code" in error && ["agent_prompt_rejected", "agent_not_ready", "agent_config_failed", "agent_config_invalid", "agent_config_busy", "agent_config_unknown"].includes(String(error.code))) {
      await refreshAgentThread(id).catch(() => {})
      const refreshed = rows.get(id)!
      refreshed.lastError = "message" in error ? String(error.message) : "The server rejected this prompt; your draft is preserved."
      if ("code" in error && String(error.code).startsWith("agent_config_")) refreshed.turnActive = false
      emit(); throw error
    }
    const submitted = current.transcript.find(event => event.type === "userMessage" && event.sequence > sequenceBeforeSend && event.text === message)
    const completed = submitted && current.transcript.some(event => event.type === "threadComplete" && event.sequence > submitted.sequence)
    if (completed && !current.turnActive && ["complete", "cancelled"].includes(current.state)) return
    current.state = "submissionUnknown"; current.turnActive = false
    current.meta = { ...current.meta, submissionUnknown: true }; persist(current)
    current.lastError = error instanceof Error ? error.message : "The prompt may have reached the server. Inspect it before retrying."
    emit(); throw error
  }
}
export async function reconcileAgentThread(id: string) {
  await nativeBridge.agentReconcile(id)
  await refreshAgentThread(id)
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
  if (!row || row.meta.sharedDeleted || restored.has(id) || ["saved", "error", "submissionUnknown", "rewinding"].includes(row.state)) throw new Error("Reconnect and refresh this request before responding.")
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
    rows.delete(previous.executionId); restored.delete(previous.executionId); historyRevisions.delete(previous.executionId); tombstones.add(previous.executionId)
    todoRefreshRevisions.delete(previous.executionId)
    subscriptions.get(previous.executionId)?.(); subscriptions.delete(previous.executionId)
  }
  const transcript = withoutObservationEvents([...(previous?.transcript || []), ...current.transcript])
  const todos = reconcileTodos(previous?.todos, previous?.todoSync, current.todos, current.todoSync, { authoritative: true, stale: current.state === "connecting" })
  rows.set(current.executionId, { ...current, todos: todos.todos, todoSync: todos.todoSync, capabilities: mergeCapabilities(current, undefined, current.capabilities), changeSummaries: previous?.changeSummaries, changeError: previous?.changeError, meta: previous?.meta || metadata(current), previousTranscript: previous ? withoutObservationEvents(previous.transcript) : undefined, transcript, touchedAt: Date.now() }); emit()
  boundRowTranscript(rows.get(current.executionId)!)
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
      if (row && ["working", "complete", "cancelled", "inputRequired"].includes(row.state)) resolve()
      else reject(new Error(row?.lastError || "The agent could not start. Check its installation and sign-in."))
    }
    timer = setTimeout(() => { listeners.delete(check); reject(new Error("Agent initialisation timed out. Check its installation and sign-in.")) }, 50000)
    listeners.add(check); check()
  })
}
export function threadTitle(row: AgentThreadRow) {
  return row.meta.title || row.transcript.find(event => event.type === "userMessage")?.text?.split("\n")[0].slice(0, 160) || `${row.remoteImported || row.state === "saved" || row.historyLoaded === false ? "Saved" : "New"} ${row.agentName} conversation`
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
  const keys = sharedFields.filter(key => Object.prototype.hasOwnProperty.call(patch, key))
  let operation: SharedOperation | undefined
  if (row.meta.shared && keys.length) {
    const changed = Object.fromEntries(keys.map(key => [key, key === "archivedAt" ? patch[key] ?? null : patch[key]]))
    const expected = Object.fromEntries(keys.map(key => [key, row.meta.shared!.fields[key] + (row.meta.sharedPending || []).filter(item => item.kind === "organization.patch" && Object.prototype.hasOwnProperty.call(item.patch || {}, key)).length]))
    operation = { ...sharedScope(row, "organization.patch"), patch: changed, expectedFields: expected }
  }
  row.meta = { ...row.meta, ...patch, id: row.meta.id, ...(operation ? { sharedPending: [...row.meta.sharedPending || [], operation] } : {}) }
  persist(row); emit()
  if (operation) void flushSharedChanges(id)
}
export function clearAgentDraft(id: string, submitted: string, submittedAttachmentIds?: string[]) {
  const row = rows.get(id)
  if (row?.meta.draft.trim() === submitted.trim() && (!submittedAttachmentIds || JSON.stringify((row.meta.draftAttachments || []).map(file => file.id)) === JSON.stringify(submittedAttachmentIds))) {
    updateThreadMeta(id, { draft: "", ...(submittedAttachmentIds ? { draftAttachments: [] } : {}) })
    return true
  }
  return false
}
export async function deleteAgentThread(id: string) {
  const row = rows.get(id)
  if (!row) return
  if (row.turnActive || row.state === "rewinding" || historyOperations.has(id)) throw new Error("Wait for the current operation before deleting this conversation.")
  if (row.meta.shared && !sharedConnections.has(row.meta.shared.serverAccountId)) throw new Error("Reconnect this account before deleting a shared conversation.")
  if (!restored.has(id)) await nativeBridge.agentClose(id)
  await flushAgentSaves()
  if (row.meta.shared && !row.meta.sharedDeleted) {
    row.meta.sharedPending = [...row.meta.sharedPending || [], { ...sharedScope(row, "conversation.delete"), expectedRevision: row.meta.shared.revision }]
    persist(row)
    await flushSharedChanges(id)
    if (!row.meta.sharedDeleted) throw new Error(row.meta.sharedSyncError || "The shared deletion was not confirmed. Your local history was preserved.")
  }
  await nativeBridge.agentDeleteSaved(row.meta.id)
  discardAgentSave(row.meta.id)
  tombstones.add(id); rows.delete(id); restored.delete(id); historyRevisions.delete(id)
  todoRefreshRevisions.delete(id)
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
  return !row.meta.sharedDeleted && row.state !== "submissionUnknown" && row.state !== "rewinding" && !historyOperations.has(row.executionId) && !resumeOperations.has(row.executionId) && !row.meta.submissionUnknown && !row.recoveryRequired && (!row.persistent || row.recoveryReason === "workerUnavailable" || row.remoteImported && !row.continuity) && !!row.resumable && !!row.agentSessionId && !row.turnActive && !row.pendingInput && !row.pendingPermission && (restored.has(row.executionId) || row.state === "error")
}
export async function resumeAgentThread(id: string, start: (agent: string, options: AgentLaunchOptions) => Promise<AgentThreadRow>, executable?: string) {
  const row = rows.get(id)
  if (!row || !canResumeAgentThread(row)) throw new Error("Refresh this conversation before resuming. An uncertain or active execution cannot be replaced safely.")
  resumeOperations.add(id)
  try {
    if (!restored.has(id)) await nativeBridge.agentClose(id)
    await flushAgentSaves()
    const next = await start(row.agentId, { cwd: row.cwd, resumeSessionId: row.agentSessionId, conversationId: row.meta.id, executable })
    if (!idleState(next)) throw new Error(next.lastError || "The saved agent session could not be resumed.")
    if (!next.previousTranscript) { next.previousTranscript = withoutObservationEvents(row.transcript); next.transcript = withoutObservationEvents([...row.transcript, ...next.transcript]) }
    boundRowTranscript(next)
    tombstones.add(id); rows.delete(id); restored.delete(id); historyRevisions.delete(id)
    todoRefreshRevisions.delete(id)
    subscriptions.get(id)?.(); subscriptions.delete(id)
    persist(next); emit(); return next
  } finally { resumeOperations.delete(id) }
}
const idleState = (row: AgentThreadRow) => ["working", "complete", "cancelled"].includes(row.state) && !row.turnActive
export function canChangeAgentHistory(row: AgentThreadRow, messageId: string, retry = false) {
  return !!row.historyCapabilities?.[retry ? "retry" : "revert"] && !row.meta.sharedDeleted && !row.recoveryReason && !resumeOperations.has(row.executionId) && !restored.has(row.executionId) && !historyOperations.has(row.executionId)
    && !row.turnActive && !row.pendingInput && !row.pendingPermission && !row.meta.submissionUnknown && !row.meta.archivedAt
    && ["working", "complete", "cancelled", "error"].includes(row.state)
    && row.transcript.some(event => event.type === "userMessage" && !event.previewTruncated && event.messageId === messageId && !!event.checkpoint)
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
  if (!row || row.turnActive || row.meta.submissionUnknown || historyOperations.has(id) || !["working", "complete", "cancelled", "error"].includes(row.state)) throw new Error("Wait until the agent is idle before changing its settings.")
  if (configOperations.has(id)) throw new Error("Wait for the previous setting update.")
  configOperations.add(id)
  try {
    await nativeBridge.agentSetConfig(id, configId, value)
    await refreshAgentThread(id)
    const updated = rows.get(id)
    if (!updated) throw new Error("The conversation disappeared while updating its settings.")
    return updated
  }
  finally { configOperations.delete(id) }
}
const configOperations = new Set<string>()
