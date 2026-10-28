import { useEffect, useRef, useState } from "react"
import type { AgentLaunchOptions } from "./types"
import { discardPreparedAgent, updateThreadMeta, type AgentThreadRow } from "../session/agentThreads"

type Preparation = { key: string; active: boolean; claimed: boolean; disposed: boolean; row?: AgentThreadRow; task?: Promise<AgentThreadRow> }
type State = { key: string; id?: string; ready: boolean; error: string }

/** A provider connection belongs to a draft until its first real prompt is sent. */
export function usePreparedAgent(key: string, enabled: boolean, agentId: string, options: AgentLaunchOptions, host: string,
  start: (agentId: string, options?: AgentLaunchOptions, created?: (row: AgentThreadRow) => void) => Promise<AgentThreadRow>) {
  const attempts = useRef(new Map<string, Preparation>())
  const callbacks = useRef({ start, options, agentId, host }); callbacks.current = { start, options, agentId, host }
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<State>({ key: "", ready: false, error: "" })
  useEffect(() => {
    if (!enabled) return
    let attempt = attempts.current.get(key)
    if (!attempt || attempt.disposed) {
      const launch = callbacks.current
      const entry: Preparation = { key, active: true, claimed: false, disposed: false }
      const created = (row: AgentThreadRow) => {
        entry.row = row
        updateThreadMeta(row.executionId, { prepared: true, hostKey: launch.host, folder: row.cwd })
        if (entry.active) setState({ key, id: row.meta.id, ready: false, error: "" })
      }
      entry.task = Promise.resolve().then(() => launch.start(launch.agentId, launch.options, created)).then(row => {
        if (!entry.row) created(row)
        entry.row = row
        if (!["working", "complete", "cancelled"].includes(row.state)) throw new Error(row.lastError || "The agent could not initialize. Check its installation and sign-in.")
        return row
      })
      attempts.current.set(key, entry)
      attempt = entry
    }
    const entry = attempt
    entry.active = true
    setState({ key, id: entry.row?.meta.id, ready: false, error: "" })
    let listening = true
    void entry.task!.then(row => { if (listening) setState({ key, id: row.meta.id, ready: true, error: "" }) }, error => {
      if (listening) setState({ key, id: entry.row?.meta.id, ready: false, error: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      listening = false; entry.active = false
      // StrictMode immediately remounts effects; its matching draft reuses this connection.
      queueMicrotask(() => {
        if (entry.active || entry.claimed) return
        entry.disposed = true
        if (attempts.current.get(key) === entry) attempts.current.delete(key)
        void entry.task!.catch(() => entry.row).then(async row => {
          if (!row || entry.claimed) return
          await discardPreparedAgent(row.executionId)
        }).catch(() => { /* A failed cleanup stays in durable history for recovery. */ })
      })
    }
  }, [key, enabled, revision])
  const active = enabled && state.key === key ? state : { key, ready: false, error: "", id: undefined }
  return {
    ...active,
    claim() {
      const entry = attempts.current.get(key)
      if (!entry || !active.ready || entry.disposed) throw new Error("Wait for the selected agent to finish connecting.")
      entry.claimed = true
      attempts.current.delete(key)
    },
    retry() { const entry = attempts.current.get(key); if (entry) entry.disposed = true; setRevision(value => value + 1) },
  }
}
