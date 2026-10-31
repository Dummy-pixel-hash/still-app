import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AgentGitDiff, AgentGitEntry, AgentGitSnapshot, AgentGitView } from "../agents/git"
import { nativeBridge } from "../bridge/nativeBridge"

export type AgentGitPhase = "idle" | "loading" | "ready" | "error" | "stale"

export interface AgentGitStatusState {
  phase: AgentGitPhase
  snapshot?: AgentGitSnapshot
  error?: string
}

export interface AgentGitDiffState {
  key: string
  phase: AgentGitPhase
  diff?: AgentGitDiff
  error?: string
}

const errorText = (error: unknown) => error && typeof error === "object" && "message" in error
  ? String(error.message) : "Repository status could not be refreshed."

export function agentGitDiffKey(snapshotId: string, entryId: string, view: AgentGitView) {
  return JSON.stringify([snapshotId, entryId, view])
}

/** Keeps repository reads scoped to one selected conversation and its SSH connection. */
export function useAgentGit({
  hostKey, nativeSessionId, cwd, conversationId, enabled, refreshEpoch = 0,
}: {
  hostKey: string
  nativeSessionId?: string
  cwd: string
  conversationId: string
  enabled: boolean
  refreshEpoch?: number
}) {
  const displayKey = useMemo(() => JSON.stringify([hostKey, cwd, conversationId]), [hostKey, cwd, conversationId])
  const requestKey = useMemo(() => JSON.stringify([displayKey, nativeSessionId || ""]), [displayKey, nativeSessionId])
  const current = useRef({ displayKey, requestKey, nativeSessionId, cwd, hostKey })
  current.current = { displayKey, requestKey, nativeSessionId, cwd, hostKey }

  const initial = useMemo(() => ({ displayKey: "", requestKey: "", phase: "idle" as AgentGitPhase }), [])
  const [statusState, setStatusState] = useState<AgentGitStatusState & { displayKey: string; requestKey: string }>(initial)
  const statusRef = useRef(statusState)
  statusRef.current = statusState
  const [diffState, setDiffState] = useState<AgentGitDiffState>({ key: "", phase: "idle" })
  const diffRef = useRef(diffState)
  diffRef.current = diffState

  const statusGeneration = useRef(new Map<string, number>())
  const diffGeneration = useRef(new Map<string, number>())
  const statusRequests = useRef(new Map<string, Promise<void>>())
  const diffRequests = useRef(new Map<string, Promise<void>>())
  const queuedRefreshes = useRef(new Set<string>())
  const selectedDiffKey = useRef("")
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const commitStatus = useCallback((value: AgentGitStatusState & { displayKey: string; requestKey: string }) => {
    statusRef.current = value
    setStatusState(value)
  }, [])
  const commitDiff = useCallback((value: AgentGitDiffState) => {
    diffRef.current = value
    setDiffState(value)
  }, [])

  const refresh = useCallback((): Promise<void> => {
    const scope = current.current
    if (!scope.nativeSessionId || !scope.cwd) {
      const previous = statusRef.current
      const snapshot = previous.displayKey === scope.displayKey ? previous.snapshot : undefined
      commitStatus({ displayKey: scope.displayKey, requestKey: scope.requestKey, phase: snapshot ? "stale" : "idle", snapshot })
      return Promise.resolve()
    }
    const pending = statusRequests.current.get(scope.requestKey)
    if (pending) return pending

    const generation = (statusGeneration.current.get(scope.requestKey) || 0) + 1
    statusGeneration.current.set(scope.requestKey, generation)
    const previous = statusRef.current
    const snapshot = previous.displayKey === scope.displayKey ? previous.snapshot : undefined
    commitStatus({ displayKey: scope.displayKey, requestKey: scope.requestKey, phase: "loading", snapshot })
    let task!: Promise<void>
    task = nativeBridge.agentGitStatus(scope.nativeSessionId, scope.cwd).then(result => {
      const latest = current.current
      if (generation !== statusGeneration.current.get(scope.requestKey) || latest.requestKey !== scope.requestKey || latest.displayKey !== scope.displayKey) return
      if (result.hostKey !== scope.hostKey || result.cwd !== scope.cwd) throw new Error("Repository response belongs to a different server or project.")
      commitStatus({ displayKey: scope.displayKey, requestKey: scope.requestKey, phase: "ready", snapshot: result })
      selectedDiffKey.current = ""
      commitDiff({ key: "", phase: "idle" })
    }).catch(error => {
      const latest = current.current
      if (generation !== statusGeneration.current.get(scope.requestKey) || latest.requestKey !== scope.requestKey || latest.displayKey !== scope.displayKey) return
      const retained = statusRef.current.displayKey === scope.displayKey ? statusRef.current.snapshot || snapshot : snapshot
      commitStatus({ displayKey: scope.displayKey, requestKey: scope.requestKey, phase: retained ? "stale" : "error", snapshot: retained, error: errorText(error) })
    }).finally(() => {
      if (statusRequests.current.get(scope.requestKey) === task) statusRequests.current.delete(scope.requestKey)
    })
    statusRequests.current.set(scope.requestKey, task)
    return task
  }, [commitDiff, commitStatus])

  const refreshAfterCurrent = useCallback((): Promise<void> => {
    const scope = current.current
    const pending = statusRequests.current.get(scope.requestKey)
    if (!pending) return refresh()
    if (!queuedRefreshes.current.has(scope.requestKey)) {
      queuedRefreshes.current.add(scope.requestKey)
      void pending.finally(() => {
        queuedRefreshes.current.delete(scope.requestKey)
        const latest = current.current
        if (enabledRef.current && latest.requestKey === scope.requestKey && latest.displayKey === scope.displayKey) void refresh()
      })
    }
    return pending
  }, [refresh])

  const loadDiff = useCallback((entry: AgentGitEntry, view: AgentGitView): Promise<void> => {
    const scope = current.current
    const state = statusRef.current
    const snapshot = state.displayKey === scope.displayKey ? state.snapshot : undefined
    if (!scope.nativeSessionId || !scope.cwd || !snapshot || state.requestKey !== scope.requestKey || snapshot.state !== "ready" || state.phase === "loading") return Promise.resolve()
    const key = agentGitDiffKey(snapshot.snapshotId, entry.id, view)
    selectedDiffKey.current = key
    const pending = diffRequests.current.get(key)
    if (pending) return pending

    const generation = (diffGeneration.current.get(key) || 0) + 1
    diffGeneration.current.set(key, generation)
    const previous = diffRef.current.key === key ? diffRef.current.diff : undefined
    commitDiff({ key, phase: "loading", diff: previous })
    let task!: Promise<void>
    task = nativeBridge.agentGitDiff(scope.nativeSessionId, scope.cwd, { snapshotId: snapshot.snapshotId, entryId: entry.id, view }).then(result => {
      const latest = current.current
      const currentSnapshot = statusRef.current.snapshot
      if (generation !== diffGeneration.current.get(key) || selectedDiffKey.current !== key || latest.requestKey !== scope.requestKey
        || latest.displayKey !== scope.displayKey || currentSnapshot?.snapshotId !== snapshot.snapshotId) return
      if (result.snapshotId !== snapshot.snapshotId || result.entryId !== entry.id || result.view !== view) throw new Error("Diff response belongs to a different repository selection.")
      commitDiff({ key, phase: result.state === "stale" ? "stale" : "ready", diff: result })
    }).catch(error => {
      const latest = current.current
      if (generation !== diffGeneration.current.get(key) || selectedDiffKey.current !== key || latest.requestKey !== scope.requestKey || latest.displayKey !== scope.displayKey) return
      commitDiff({ key, phase: "error", diff: previous, error: errorText(error) })
    }).finally(() => {
      if (diffRequests.current.get(key) === task) diffRequests.current.delete(key)
    })
    diffRequests.current.set(key, task)
    return task
  }, [commitDiff])

  const previousRefreshEpoch = useRef(refreshEpoch)
  useEffect(() => {
    const reattached = previousRefreshEpoch.current !== refreshEpoch
    previousRefreshEpoch.current = refreshEpoch
    if (enabled) void (reattached ? refreshAfterCurrent() : refresh())
  }, [enabled, requestKey, refreshEpoch, refresh, refreshAfterCurrent])

  const status: AgentGitStatusState = statusState.displayKey === displayKey
    ? statusState.requestKey === requestKey ? statusState : { ...statusState, phase: statusState.snapshot ? "stale" : "idle", error: undefined }
    : { phase: "idle" }

  return { status, diff: diffState, refresh, refreshAfterCurrent, loadDiff }
}
