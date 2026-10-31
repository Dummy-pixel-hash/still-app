import { useSyncExternalStore } from "react"
import type { AgentAvailability } from "../agents/types"

type Discovery = { agents: AgentAvailability[]; checking: boolean; checkedAt?: number; error?: string; selectionKey?: string; stale: boolean }
const cache = new Map<string, Discovery>()
const pending = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
let version = 0
const emit = () => { version++; listeners.forEach(fn => fn()) }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const storageKey = (host: string) => `still.agents.discovery.v2:${host}`

export function agentDiscoverySelectionKey(transportId: string | undefined, overrides: Record<string, string | undefined>, providerIds: readonly string[]) {
  return JSON.stringify([transportId || "", providerIds.map(id => [id, overrides[id]?.trim() || ""])])
}

function state(host: string): Discovery {
  if (!cache.has(host)) {
    let saved: Discovery = { agents: [], checking: false, stale: true }
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey(host)) || "null")
      if (Array.isArray(raw?.agents)) saved = { ...raw, checking: false, stale: true }
    } catch { /* Empty on first use. */ }
    cache.set(host, saved)
  }
  return cache.get(host)!
}

export function useAgentDiscovery(host: string, selectionKey: string) {
  useSyncExternalStore(subscribe, () => version, () => version)
  const current = state(host)
  const selectionMatches = current.selectionKey === selectionKey
  return {
    ...current,
    checking: selectionMatches && current.checking,
    error: selectionMatches ? current.error : undefined,
    stale: current.stale || !selectionMatches,
  }
}

export function discoverAgents(host: string, selectionKey: string, check: () => Promise<AgentAvailability[]>) {
  const requestKey = JSON.stringify([host, selectionKey])
  const existing = pending.get(requestKey)
  if (existing) {
    if (cache.get(host)?.selectionKey !== selectionKey) {
      cache.set(host, { ...state(host), checking: true, error: undefined, selectionKey, stale: true }); emit()
    }
    return existing
  }
  cache.set(host, { ...state(host), checking: true, error: undefined, selectionKey, stale: true }); emit()
  const task = Promise.resolve().then(check).then(agents => {
    // The host has one readable cache, but a response may only replace the
    // selection that was current when its request began.
    if (cache.get(host)?.selectionKey !== selectionKey) return
    const next: Discovery = { agents, checking: false, checkedAt: Date.now(), selectionKey, stale: false }
    cache.set(host, next)
    try { localStorage.setItem(storageKey(host), JSON.stringify(next)) } catch { /* Cache only. */ }
  }).catch(error => {
    if (cache.get(host)?.selectionKey !== selectionKey) return
    cache.set(host, { ...state(host), checking: false, stale: true, error: error instanceof Error ? error.message : "Could not check this server." })
  }).finally(() => { pending.delete(requestKey); emit() })
  pending.set(requestKey, task)
  return task
}
