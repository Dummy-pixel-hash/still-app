import { useSyncExternalStore } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import type { AgentLibrary } from "../agents/types"

const listeners = new Set<() => void>()
let status = { ready: false, pending: 0, error: "", warnings: [] as string[], path: "" }
let initialization: Promise<AgentLibrary> | undefined
let workspaces: Record<string, unknown> = {}
let writes = Promise.resolve()
const changes = new Map<string, () => Promise<void>>()
let timer: ReturnType<typeof setTimeout> | undefined
const errors = new Map<string, string>()
const revisions = new Map<string, number>()
let pendingWrites = 0
let storageSubscribed = false
let closeSubscribed = false
const describe = (e: unknown) => e && typeof e === "object" && "message" in e ? String(e.message) : String(e)
const publish = (patch: Partial<typeof status>) => {
  if (Object.entries(patch).every(([key, value]) => status[key as keyof typeof status] === value)) return
  status = { ...status, ...patch }; listeners.forEach(fn => fn())
}
export const useAgentStorage = () => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => status)
export const useAgentStorageError = () => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => status.error)
export const storedWorkspace = (key: string) => workspaces[key]
export const storedWorkspaces = () => workspaces

export function initializeAgentStorage(migrate: () => { rows: unknown[]; deleted: string[]; workspaces: object }) {
  if (initialization) return initialization
  initialization = (async () => {
    if (!storageSubscribed) await nativeBridge.subscribeAgentStorage(event => {
      if (event.error) errors.set(`events:${event.conversationId}`, event.error)
      else errors.delete(`events:${event.conversationId}`)
      publish({ error: [...errors.values()][0] || "" })
    })
    storageSubscribed = true
    if (!nativeBridge.isDevelopmentAdapter && !closeSubscribed && "__TAURI_INTERNALS__" in window) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      const window = getCurrentWindow()
      let allowClose = false, closing = false
      await window.onCloseRequested(async event => {
        if (allowClose) return
        event.preventDefault()
        if (closing) return
        closing = true
        await flushAgentSaves()
        if (changes.size && !errors.size) await flushAgentSaves()
        const unsaved = changes.size || pendingWrites || [...errors.keys()].some(key => key === "native-flush" || key.startsWith("events:"))
        if (!unsaved) { allowClose = true; await window.close() }
        closing = false
      })
      closeSubscribed = true
    }
    let warnings: string[] = []
    let migrated = false
    try {
      if (localStorage.getItem("still.agents.migrated.v3") !== "yes") {
        const legacy = migrate()
        warnings = await nativeBridge.agentMigrate(legacy.rows, legacy.deleted, legacy.workspaces)
        migrated = !warnings.length
      }
    } catch (error) { warnings.push(`Existing history could not be migrated: ${describe(error)}. The original cache is retained.`) }
    const library = await nativeBridge.agentLibrary()
    if (migrated && !library.warnings.length) {
      try {
        localStorage.setItem("still.agents.migrated.v3", "yes")
        for (const key of ["still.agents.index.v1", "still.agents.index.v2", "still.agents.deleted.v2", "still.agents.workspace.v2"]) localStorage.removeItem(key)
      } catch { warnings.push("History was migrated; the old WebView cache could not be cleared.") }
    }
    workspaces = library.workspaces
    errors.delete("library")
    publish({ ready: true, error: [...errors.values()][0] || "", path: library.storagePath, warnings: [...warnings, ...library.warnings] })
    return library
  })().catch(error => {
    errors.set("library", `Local history could not be opened: ${describe(error)}`)
    publish({ ready: false, error: errors.get("library")! })
    initialization = undefined
    throw error
  })
  return initialization
}

export function scheduleAgentSave(key: string, save: () => Promise<void>) {
  changes.set(key, save)
  revisions.set(key, (revisions.get(key) || 0) + 1)
  publish({ pending: changes.size + pendingWrites })
  if (!timer) timer = setTimeout(() => { timer = undefined; void flushAgentSaves() }, 150)
}

export function flushAgentSaves(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = undefined
  const batch = [...changes].map(([key, save]) => ({ key, save, revision: revisions.get(key) })); changes.clear()
  pendingWrites += batch.length
  writes = writes.then(async () => {
    for (const { key, save, revision } of batch) {
      try { await save(); errors.delete(key) }
      catch (error) { if (revisions.get(key) === revision) { errors.set(key, `Conversation changes could not be saved on this device: ${describe(error)}`); changes.set(key, save) } }
      finally { pendingWrites-- }
    }
    try { await nativeBridge.agentFlush(); errors.delete("native-flush") }
    catch (error) { errors.set("native-flush", describe(error)) }
    publish({ pending: changes.size + pendingWrites, error: [...errors.values()][0] || "" })
  })
  return writes
}

export function saveAgentWorkspace(key: string, value: object) {
  workspaces = { ...workspaces, [key]: value }
  scheduleAgentSave(`workspace:${key}`, () => nativeBridge.agentSaveWorkspace(key, value))
}

export function discardAgentSave(key: string) { changes.delete(key); errors.delete(key); revisions.set(key, (revisions.get(key) || 0) + 1) }
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { void flushAgentSaves() })
  document.addEventListener("visibilitychange", () => { if (document.hidden) void flushAgentSaves() })
}
