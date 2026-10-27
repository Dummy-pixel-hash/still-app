import { useCallback, useEffect, useRef, useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import { agentConnectionId } from "../agents/workspace"
import { buildConnectRequest, type AskSessionAuth } from "../session/connectRequest"
import { clearHostKeyPrompt, connectionError, connectionState, disconnectSession, forgetStoredHostKey, hostKeyPromptFor, isConnectPending, nativeSessionId, reconnectSession, useConnections } from "../session/connections"
import type { Session } from "../types"

export function useAgentConnection(session: Session | null, askAuth: AskSessionAuth, keyTextFor: (id: string) => string | null) {
  useConnections()
  const localId = session ? agentConnectionId(session) : "agents:offline"
  const state = connectionState(localId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true), attempted = useRef("")
  const connecting = useRef("")
  const callbacks = useRef({ askAuth, keyTextFor, session })
  callbacks.current = { askAuth, keyTextFor, session }
  const connect = useCallback(async () => {
    if (!callbacks.current.session) return
    if (connecting.current === localId || isConnectPending(localId) || connectionState(localId) === "connected") return
    connecting.current = localId
    setBusy(true); setError(null)
    try {
      const { session: target, askAuth: ask, keyTextFor: key } = callbacks.current
      if (!target) return
      const req = await buildConnectRequest(target, ask, key, { localId, sshOnly: true })
      if (req && mounted.current && callbacks.current.session && agentConnectionId(callbacks.current.session) === localId) await reconnectSession(req)
    } catch (e) { if (mounted.current && connecting.current === localId) setError(e instanceof Error ? e.message : "Could not connect to the server.") }
    finally { if (connecting.current === localId) { connecting.current = ""; if (mounted.current) setBusy(false) } }
  }, [localId])
  useEffect(() => {
    mounted.current = true
    if (session && attempted.current !== localId) { attempted.current = localId; setError(null); void connect() }
    return () => { mounted.current = false }
  }, [localId, connect, !!session])
  return { localId, state, busy, error: error || connectionError(localId), nativeId: nativeSessionId(localId), hostPrompt: hostKeyPromptFor(localId), connect }
}
export function AgentConnectionNotice({ connection }: { connection: ReturnType<typeof useAgentConnection> }) {
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const prompt = connection.hostPrompt
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : "Connection action failed") } finally { setBusy(false) } }
  if (connection.state === "connected") return null
  if (prompt) return <section className="agent-connection-notice" role="region" aria-label="Verify server identity">
    <strong>{prompt.changed ? "Server identity has changed" : "Verify this server"}</strong><p>{prompt.host}:{prompt.port}</p><code>{prompt.fingerprint}</code>
    <p>{prompt.changed ? "Compare the new fingerprint with your server administrator. Remove the saved key only after verifying the change." : "Check this fingerprint before trusting the connection."}</p>
    <div className="agent-inline-actions">{prompt.changed ? <button className="agent-button" disabled={busy} onClick={() => void act(() => forgetStoredHostKey(connection.localId, prompt.host, prompt.port))}>Remove saved key</button>
      : <button className="agent-primary" disabled={busy} onClick={() => void act(async () => { await nativeBridge.trustHost(prompt.host, prompt.port, prompt.opensshKey); clearHostKeyPrompt(connection.localId); await connection.connect() })}>Trust and connect</button>}
      <button className="agent-button" disabled={busy} onClick={() => void act(async () => { clearHostKeyPrompt(connection.localId); await disconnectSession(connection.localId) })}>Cancel</button></div>{error && <p role="alert">{error}</p>}
  </section>
  return <div className="agent-connection-notice" role="status"><strong>{connection.busy || connection.state === "connecting" ? "Connecting to your server…" : "Connect to use your agents"}</strong>
    {connection.error && <p>{connection.error}</p>}{!connection.busy && connection.state !== "connecting" && <button className="agent-button" onClick={() => void connection.connect()}>Connect server</button>}</div>
}
