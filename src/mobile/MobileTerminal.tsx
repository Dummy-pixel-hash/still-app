import { useCallback, useEffect, useRef, useState } from "react"
import SessionTerminal from "../terminal/SessionTerminal"
import { AgentConnectionNotice } from "../components/AgentConnection"
import { buildConnectRequest, type AskSessionAuth } from "../session/connectRequest"
import { connectionError, connectionState, hostKeyPromptFor, isConnectPending, nativeSessionId, reconnectSession, terminalForSession, useConnections, writeSession } from "../session/connections"
import { nativeBridge } from "../bridge/nativeBridge"
import type { AppSettings, Session } from "../types"
import MobileIcon from "./MobileIcon"

export default function MobileTerminal({ session, settings, askAuth, onBack }: { session: Session; settings: AppSettings; askAuth: AskSessionAuth; onBack: () => void }) {
  useConnections()
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [paste, setPaste] = useState<string | null>(null)
  const mounted = useRef(true), connecting = useRef(false)
  const connect = useCallback(async () => {
    if (connecting.current || isConnectPending(session.id) || connectionState(session.id) === "connected") return
    connecting.current = true; setBusy(true); setError(null)
    try {
      const request = await buildConnectRequest(session, askAuth, () => null)
      if (request && mounted.current) await reconnectSession(request)
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not connect.") }
    finally { connecting.current = false; if (mounted.current) setBusy(false) }
  }, [session, askAuth])
  useEffect(() => { mounted.current = true; void connect(); return () => { mounted.current = false } }, [connect])
  const state = connectionState(session.id)
  const key = (sequence: string) => { if (state === "connected") void writeSession(session.id, sequence).catch(failure => setError(String(failure))); terminalForSession(session.id).focus() }
  const insertPaste = (text: string) => { terminalForSession(session.id).paste(text); setPaste(null) }
  return <section className="mobile-terminal" aria-label={`${session.name} terminal`}>
    <header className="mobile-detail-bar"><button className="mobile-icon-button" onClick={onBack} aria-label="Back to terminals"><MobileIcon name="back" /></button><div><h1>{session.name}</h1><p><span className={`mobile-status-dot ${state === "connected" ? "is-connected" : ""}`} />{session.username}@{session.host}</p></div><button className="mobile-icon-button" aria-label="Show terminal keyboard" onClick={() => terminalForSession(session.id).focus()}><MobileIcon name="keyboard" /></button></header>
    {state !== "connected" && <AgentConnectionNotice connection={{ localId: session.id, state, busy, error: error || connectionError(session.id), nativeId: nativeSessionId(session.id), hostPrompt: hostKeyPromptFor(session.id), connect }} />}
    <div className="mobile-terminal-canvas"><SessionTerminal localId={session.id} prefs={settings.terminal} imageInsertStyle={settings.imageInsertStyle} paused={state !== "connected"} /></div>
    {error && <p className="mobile-error" role="alert">{error}</p>}
    <div className="mobile-terminal-keys" aria-label="Terminal keys">
      <button disabled={state !== "connected"} onClick={() => key("\x03")}>Ctrl+C</button><button disabled={state !== "connected"} onClick={() => key("\x1b")}>Esc</button><button disabled={state !== "connected"} onClick={() => key("\t")}>Tab</button>
      {[["arrow-left", "\x1b[D", "Left"], ["arrow-down", "\x1b[B", "Down"], ["arrow-up", "\x1b[A", "Up"], ["arrow-right", "\x1b[C", "Right"]].map(([name, sequence, label]) => <button key={name} disabled={state !== "connected"} aria-label={`${label} arrow`} onClick={() => key(sequence)}><MobileIcon name={name as "arrow-left"} size={18} /></button>)}
      <button disabled={state !== "connected"} aria-label="Paste into terminal" onClick={() => { void nativeBridge.clipboardReadText().then(text => { if (/[\r\n]/.test(text)) setPaste(text); else insertPaste(text) }).catch(failure => setError(String(failure))) }}><MobileIcon name="paste" size={18} /></button>
    </div>
    {paste !== null && <div className="mobile-sheet-scrim"><section className="mobile-sheet" role="dialog" aria-modal="true" aria-label="Confirm terminal paste"><h2>Paste multiple lines?</h2><p>Line breaks may execute commands in your remote shell.</p><pre>{paste.slice(0, 1200)}</pre><button className="mobile-primary" onClick={() => insertPaste(paste)}>Paste into terminal</button><button className="mobile-text-button" onClick={() => setPaste(null)}>Cancel</button></section></div>}
  </section>
}
