import { useCallback, useEffect, useRef, useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import { connectionState, hostKeyPromptFor, nativeSessionId, subscribeSessionData } from "../session/connections"
import { updateSettings } from "../session/store"
import { OrbPublisher, type OrbPublisherState } from "./publisher"
import type { OrbAction, OrbPreferences, OrbSessionInput } from "./types"
import type { Session } from "../types"

/** Mount once in Workspace, never in OrbScreen. Workspace observes connection changes. */
export function useOrbPublisher(
  sessions: readonly Session[],
  authSessionId: string | null,
  preferences: OrbPreferences,
  activate: (sessionId: string | null) => void,
) {
  const [state, setState] = useState<OrbPublisherState>({ pending: false, error: null })
  const [attempt, setAttempt] = useState(0)
  const publisher = useRef<OrbPublisher | null>(null)
  const onAction = useRef<(action: OrbAction) => void>(() => {})
  onAction.current = action => {
    if (action.type === "preferences") updateSettings({ orb: action.preferences })
    if (action.type === "open") activate(action.sessionId)
  }
  useEffect(() => {
    const instance = new OrbPublisher({
      bridge: nativeBridge, subscribeData: subscribeSessionData,
      onAction: action => onAction.current(action), onState: setState,
    })
    publisher.current = instance
    return () => { instance.dispose(); publisher.current = null }
  }, [attempt])

  // This intentionally runs after each Workspace render: useConnections returns
  // the same Map reference while its version changes. The publisher fingerprints
  // inputs, so unrelated UI renders are cheap and do not cause IPC traffic.
  useEffect(() => {
    const inputs: OrbSessionInput[] = sessions.map(session => {
      const key = hostKeyPromptFor(session.id)
      return {
        id: session.id, name: session.name,
        connection: connectionState(session.id), nativeId: nativeSessionId(session.id),
        attention: authSessionId === session.id ? "auth" : key ? (key.changed ? "host-key-changed" : "host-key") : null,
        changedAt: session.lastOpenedAt ?? session.updatedAt,
      }
    })
    publisher.current?.update(inputs, preferences)
  })
  const retry = useCallback(() => { setState({ pending: true, error: null }); setAttempt(value => value + 1) }, [])
  return { ...state, retry }
}
