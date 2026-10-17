import { useEffect, useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import { emptyOrbSnapshot, orbSummary } from "./state"
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
  useEffect(() => {
    if (!snapshot.preferences.enabled) return
    const tick = () => setNow(Date.now())
    const timer = window.setInterval(tick, 1000)
    document.addEventListener("visibilitychange", tick)
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick) }
  }, [snapshot.preferences.enabled])
  return { snapshot, summary: orbSummary(snapshot, now), error, now }
}
