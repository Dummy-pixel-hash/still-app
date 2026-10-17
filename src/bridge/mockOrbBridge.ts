import { emptyOrbSnapshot, MAX_ORB_ROWS, normalizeOrbPreferences, orbSummary } from "../orb/state"
import type { OrbAction, OrbBridge, OrbSnapshot } from "../orb/types"

/** Browser-only state transport. Its companion is a labelled in-app preview. */
export function createMockOrbBridge(): OrbBridge {
  let snapshot = emptyOrbSnapshot()
  const listeners = new Set<(snapshot: OrbSnapshot) => void>()
  const actions = new Set<(action: OrbAction) => void>()
  const copy = () => structuredClone(snapshot)
  const emit = () => { snapshot.revision++; listeners.forEach(fn => fn(copy())) }
  const action = (event: OrbAction) => actions.forEach(fn => fn(structuredClone(event)))
  return {
    async orbConfigure(preferences) {
      snapshot.preferences = normalizeOrbPreferences(preferences)
      emit()
      return copy()
    },
    async orbPublish(rows) {
      snapshot.rows = structuredClone(rows.slice(0, MAX_ORB_ROWS))
      snapshot.publishedAt = Date.now()
      emit()
    },
    async orbSnapshot() { return copy() },
    async subscribeOrbSnapshot(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    async subscribeOrbActions(fn) { actions.add(fn); return () => { actions.delete(fn) } },
    async orbCommand(command) {
      switch (command.type) {
        case "workspace": action({ type: "open", sessionId: null }); break
        case "open": {
          const summary = orbSummary(snapshot, Date.now())
          const id = command.sessionId ?? summary.row?.sessionId ?? null
          if (id !== null && !summary.rows.some(row => row.sessionId === id)) throw new Error("Session is no longer available")
          action({ type: "open", sessionId: id })
          break
        }
        case "hide":
          snapshot.preferences = { ...snapshot.preferences, enabled: false }
          emit(); action({ type: "preferences", preferences: snapshot.preferences }); break
        case "pause":
          snapshot.preferences = { ...snapshot.preferences, paused: command.paused }
          emit(); action({ type: "preferences", preferences: snapshot.preferences }); break
        case "reset": action({ type: "reset" }); break
        default:
          // These are handled by the actual preview UI, not pretend OS calls.
          throw new Error("Native window operations are unavailable in the browser preview")
      }
    },
  }
}
