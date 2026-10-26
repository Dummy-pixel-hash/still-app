import { useSyncExternalStore } from "react"
import type { AgentAvailability } from "../agents/types"

type Discovery = { agents: AgentAvailability[]; checking: boolean; checkedAt?: number; error?: string }
const cache = new Map<string, Discovery>()
const pending = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
let version = 0
const emit = () => { version++; listeners.forEach(fn => fn()) }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
function state(host: string): Discovery {
  if (!cache.has(host)) {
    let saved: Discovery = { agents: [], checking: false }
    try { const raw = JSON.parse(localStorage.getItem(`still.agents.discovery.v2:${host}`) || "null"); if (Array.isArray(raw?.agents)) saved = { ...raw, checking: false } } catch { /* Empty on first use. */ }
    cache.set(host, saved)
  }
  return cache.get(host)!
}
export function useAgentDiscovery(host: string) {
  useSyncExternalStore(subscribe, () => version, () => version)
  return state(host)
}
export function discoverAgents(host: string, check: () => Promise<AgentAvailability[]>) {
  if (pending.has(host)) return pending.get(host)!
  cache.set(host, { ...state(host), checking: true, error: undefined }); emit()
  const task = check().then(agents => {
    const next = { agents, checking: false, checkedAt: Date.now() }
    cache.set(host, next)
    try { localStorage.setItem(`still.agents.discovery.v2:${host}`, JSON.stringify(next)) } catch { /* Cache only. */ }
  }).catch(error => {
    cache.set(host, { ...state(host), checking: false, error: error instanceof Error ? error.message : "Could not check this server." })
  }).finally(() => { pending.delete(host); emit() })
  pending.set(host, task)
  return task
}
