import { useEffect, useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import { OUTPUT_ACTIVE_MS, PUBLISH_STALE_MS, emptyOrbSnapshot, orbSummary } from "./state"
import { watchOrbSnapshot } from "./subscription"

export function useOrbView() {
  const [snapshot, setSnapshot] = useState(emptyOrbSnapshot)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => watchOrbSnapshot(nativeBridge, next => {
    setSnapshot(next)
    setNow(Date.now())
    setError(null)
  }, () => setError("Status unavailable. Open Still to check your sessions.")), [])
  // Tick only while a row's freshness can still change the readout: output
  // "active" expires after OUTPUT_ACTIVE_MS and the snapshot goes stale after
  // PUBLISH_STALE_MS. An idle orb has nothing to recompute, so a permanent
  // 1 Hz re-render is pure cost.
  useEffect(() => {
    if (!snapshot.preferences.enabled) return
    const tick = () => setNow(Date.now())
    const newest = Math.max(
      snapshot.publishedAt,
      ...snapshot.rows.map(row => row.lastOutputAt ?? 0),
    )
    const remaining = Math.max(
      PUBLISH_STALE_MS - (Date.now() - snapshot.publishedAt),
      snapshot.rows.some(row => row.lastOutputAt !== null)
        ? OUTPUT_ACTIVE_MS - (Date.now() - newest)
        : 0,
    )
    if (remaining <= 0) return
    const timer = window.setTimeout(tick, Math.min(1000, remaining + 50))
    document.addEventListener("visibilitychange", tick)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [snapshot])
  return { snapshot, summary: orbSummary(snapshot, now), error, now }
}
