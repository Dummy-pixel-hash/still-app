import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import SessionTerminal from "../terminal/SessionTerminal"
import {
  clearHostKeyPrompt,
  connectionError,
  connectionState,
  disconnectSession,
  hostKeyPromptFor,
  reconnectSession,
  useConnections,
  type ConnectRequest,
} from "../session/connections"
import { nativeBridge } from "../bridge/nativeBridge"
import type { Session, TerminalPrefs } from "../types"

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"

export interface OpenState {
  session: Session
  rect: DOMRect
  phase: "enter" | "open" | "exit"
}

interface AuthPrompt {
  password: string
  keyText: string
  remember: boolean
}

/**
 * Card-origin morph overlay hosting the REAL terminal.
 * Workspace stays mounted underneath (scaled/dimmed/blurred); closing
 * reverses the transition. Leaving is NOT a disconnect — the worker keeps
 * running; only explicit Disconnect drops the SSH channel (tmux survives).
 */
export default function TerminalOverlay({
  open,
  authOpen,
  prefs,
  keyTextFor,
  onClose,
  onNeedAuth,
}: {
  open: OpenState | null
  prefs: TerminalPrefs
  keyTextFor: (keyId: string) => string | null
  onClose: () => void
  onNeedAuth: (
    session: Session,
  ) => Promise<{ secret?: string; remember: boolean } | null>
  authOpen: boolean
}) {
  useConnections()
  const full = open?.phase === "open"
  const [chrome, setChrome] = useState(true)
  const hide = useRef(0)
  const [prompt, setPrompt] = useState<AuthPrompt | null>(null)
  const [busy, setBusy] = useState(false)
  const session = open?.session ?? null
  const localId = session?.id ?? ""
  const state = session ? connectionState(session.id) : "disconnected"
  const lastError = session ? connectionError(session.id) : null
  // M5: pending untrusted-host prompt (fingerprint Trust/Reject). The worker
  // refused BEFORE auth; trust is an explicit user action, persisted by Rust.
  const hostPrompt = session ? hostKeyPromptFor(session.id) : null
  const [trustBusy, setTrustBusy] = useState(false)
  const trustHost = useCallback(async () => {
    if (!session || !hostPrompt || trustBusy) return
    setTrustBusy(true)
    try {
      // Rust re-probes the live key and stores it only if unchanged.
      await nativeBridge.trustHost(hostPrompt.host, hostPrompt.port, hostPrompt.opensshKey)
      clearHostKeyPrompt(session.id)
      await doConnectRef.current()
    } catch (e) {
      // Leave the prompt up; the error line below shows the typed refusal.
      console.error("trustHost refused:", e)
    } finally {
      setTrustBusy(false)
    }
  }, [session, hostPrompt, trustBusy])
  const doConnectRef = useRef<() => Promise<void>>(async () => {})

  const show = useCallback((ms = 2000) => {
    setChrome(true)
    window.clearTimeout(hide.current)
    hide.current = window.setTimeout(() => setChrome(false), ms)
  }, [])

  useEffect(() => {
    if (full) show(2800)
    return () => window.clearTimeout(hide.current)
  }, [full, show])

  const buildRequest = useCallback(
    async (s: Session): Promise<ConnectRequest | null> => {
      const dims = { cols: 80, rows: 24 }
      const base = {
        localId: s.id,
        host: s.host,
        port: s.port,
        username: s.username,
        tmuxSession: s.tmuxSession,
        ...dims,
      }
      if (s.authMethod === "password") {
        if (prompt) {
          const secret = prompt.password || undefined
          return {
            ...base,
            authKind: "password" as const,
            secret,
            remember: prompt.remember,
          }
        }
        const ans = await onNeedAuth(s)
        if (!ans) return null
        return {
          ...base,
          authKind: "password" as const,
          secret: ans.secret,
          remember: ans.remember,
        }
      }
      if (s.authMethod === "key" && s.keyId) {
        const text = keyTextFor(s.keyId)
        if (text) {
          return {
            ...base,
            authKind: "privateKey" as const,
            secret: text,
            remember: false,
          }
        }
        const ans = await onNeedAuth(s)
        if (!ans) return null
        return {
          ...base,
          authKind: "privateKey" as const,
          secret: ans.secret,
          remember: ans.remember,
        }
      }
      // ask: prompt every time, transient only.
      const ans = await onNeedAuth(s)
      if (!ans) return null
      return {
        ...base,
        authKind: (s.authMethod === "key" ? "privateKey" : "password") as
          | "password"
          | "privateKey",
        secret: ans.secret,
        remember: ans.remember,
      }
    },
    [keyTextFor, onNeedAuth, prompt],
  )

  const doConnect = useCallback(async () => {
    if (!session || busy) return
    setBusy(true)
    try {
      const req = await buildRequest(session)
      if (req) {
        setPrompt(null)
        await reconnectSession(req)
      }
    } finally {
      setBusy(false)
    }
  }, [buildRequest, busy, session])


  // Keep a stable ref so the Trust action can re-run the full connect flow.
  useEffect(() => {
    doConnectRef.current = doConnect
  }, [doConnect])

  // Auto-connect on first open: if a password was pre-filled inline, use it;
  // otherwise immediately run the auth flow so an unconnected session never
  // sits silently with input paused. doConnect internally prompts when needed.
  const autoTried = useRef<string | null>(null)
  useEffect(() => {
    if (full && session && connectionState(session.id) === "disconnected" && !busy && autoTried.current !== session.id) {
      autoTried.current = session.id
      void doConnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full])

  const touch = useRef<number | null>(null)
  const r = open?.rect
  const style: React.CSSProperties = full
    ? { top: 0, left: 0, width: "100vw", height: "100vh", borderRadius: 0 }
    : {
        top: r?.top ?? 0,
        left: r?.left ?? 0,
        width: r?.width ?? 0,
        height: r?.height ?? 0,
        borderRadius: 8,
      }

  return (
    <div
      className={`fixed z-50 overflow-hidden bg-[#08080a] transition-all duration-[650ms] ${
        !open ? "hidden" : ""
      }`}
      aria-hidden={!open}
      style={{
        ...style,
        transitionTimingFunction: EASE,
        boxShadow: full ? "none" : "0 0 0 1px rgba(255,255,255,0.08)",
      }}
      onMouseMove={(e) => {
        if (e.clientY < 56) show(1800)
      }}
      onTouchStart={(e) => {
        touch.current =
          e.touches[0].clientY < 40 ? e.touches[0].clientY : null
      }}
      onTouchMove={(e) => {
        if (touch.current !== null) {
          if (e.touches[0].clientY - touch.current > 24) show(2500)
          if (e.touches[0].clientY - touch.current > 90) {
            touch.current = null
            onClose()
          }
        }
      }}
    >
      <div
        className="relative h-full w-full transition-opacity"
        style={{
          opacity: full ? 1 : 0,
          transitionDuration: full ? "600ms" : "150ms",
          transitionDelay: full ? "350ms" : "0ms",
        }}
      >
        {open && full ? (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <SessionTerminal
                key={`${open.session.id}-${open.session.updatedAt}`}
                localId={open.session.id}
                prefs={prefs}
                paused={
                  !full ||
                  state === "disconnected" ||
                  state === "error" ||
                  authOpen
                }
              />
            </div>
            {hostPrompt && (
              <div
                role="alertdialog"
                aria-label={hostPrompt.changed ? "Host key changed" : "Unknown host key"}
                className="flex shrink-0 flex-col gap-2 border-t border-amber-400/30 bg-amber-950/40 px-4 py-3"
              >
                <p className="font-mono text-[12px] font-semibold text-amber-200">
                  {hostPrompt.changed
                    ? "⚠ HOST KEY CHANGED — possible attack. Connection refused."
                    : "Unknown SSH host — verify before trusting."}
                </p>
                <p className="font-mono text-[11px] text-dim">
                  {hostPrompt.host}:{hostPrompt.port} · {hostPrompt.keyType}
                </p>
                <p className="break-all font-mono text-[12px] text-fg" data-testid="host-fingerprint">
                  {hostPrompt.fingerprint}
                </p>
                <p className="break-all font-mono text-[10px] text-dim">{hostPrompt.opensshKey}</p>
                {!hostPrompt.changed && (
                  <p className="font-mono text-[11px] text-dim">
                    Compare with the server admin out-of-band. Trust stores this key on this device only.
                  </p>
                )}
                {hostPrompt.changed && (
                  <p className="font-mono text-[11px] text-amber-200/90">
                    A different key is already trusted for this host. Still will NOT overwrite it.
                    Contact the server admin out-of-band before doing anything.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  {!hostPrompt.changed && (
                    <button
                      type="button"
                      disabled={trustBusy}
                      onClick={() => void trustHost()}
                      className="rounded-full bg-amber-400 px-4 py-1.5 text-[12px] font-semibold text-black transition hover:bg-amber-300 disabled:opacity-50"
                    >
                      {trustBusy ? "Trusting…" : "Trust this server"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => session && clearHostKeyPrompt(session.id)}
                    className="rounded-full bg-white/[0.08] px-4 py-1.5 text-[12px] text-fg transition hover:bg-white/[0.14]"
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
            {!hostPrompt && (state === "disconnected" || state === "error") && (
              <div className="flex shrink-0 flex-col gap-2 border-t border-white/[0.07] bg-black/60 px-4 py-3">
                <p className="font-mono text-[11px] text-dim">
                  {state === "error"
                    ? (lastError ?? "Connection failed.")
                    : "Not connected. Remote tmux persists server-side."}
                </p>
                {session && session.authMethod === "password" && (
                  <input
                    type="password"
                    autoComplete="off"
                    value={prompt?.password ?? ""}
                    onChange={(e) =>
                      setPrompt((p) => ({
                        password: e.target.value,
                        keyText: p?.keyText ?? "",
                        remember: p?.remember ?? session.remember,
                      }))
                    }
                    placeholder="Password (per-connect only, never stored)"
                    aria-label="Password"
                    className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 font-mono text-[12px] text-fg outline-none focus:border-[#ff4a4a]/50"
                  />
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || !session}
                    onClick={() => void doConnect()}
                    className="rounded-full bg-white/[0.08] px-4 py-1.5 text-[12px] text-fg transition hover:bg-white/[0.14] disabled:opacity-50"
                  >
                    {busy
                      ? "Connecting…"
                      : state === "error"
                        ? "Retry"
                        : "Connect"}
                  </button>
                  {session && session.authMethod === "password" && (
                    <label className="flex items-center gap-1.5 font-mono text-[11px] text-dim">
                      <input
                        type="checkbox"
                        checked={prompt?.remember ?? session.remember}
                        onChange={(e) =>
                          setPrompt((p) => ({
                            password: p?.password ?? "",
                            keyText: p?.keyText ?? "",
                            remember: e.target.checked,
                          }))
                        }
                      />
                      Remember on this device
                    </label>
                  )}
                </div>
              </div>
            )}
            {(state === "connecting" || state === "connected") && (
              <div className="flex shrink-0 items-center gap-2 border-t border-white/[0.07] bg-black/60 px-4 py-2">
                <span
                  className={`h-[7px] w-[7px] rounded-full ${
                    state === "connected"
                      ? "bg-[#ff4a4a] shadow-[0_0_8px_1px_rgba(255,74,74,0.7)] animate-[breathe_2.4s_ease-in-out_infinite]"
                      : "animate-pulse bg-[#e8c4a0]"
                  }`}
                />
                <span className="font-mono text-[11px] text-dim">
                  {state === "connected"
                    ? `live · tmux ${session?.tmuxSession}`
                    : "connecting…"}
                </span>
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => void doConnect()}
                    className="rounded-full bg-white/[0.06] px-3 py-1 font-mono text-[11px] text-dim transition hover:bg-white/[0.12] hover:text-fg"
                  >
                    Reconnect
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (session) void disconnectSession(session.id)
                    }}
                    className="rounded-full bg-white/[0.06] px-3 py-1 font-mono text-[11px] text-dim transition hover:bg-white/[0.12] hover:text-fg"
                  >
                    Disconnect
                  </button>
                </span>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {full &&
        createPortal(
          <div
            className="fixed left-1/2 top-3 z-[65] flex items-center gap-3 rounded-full bg-[#121214]/80 py-1.5 pl-4 pr-1.5 text-[12px] shadow-[0_0_0_1px_rgba(255,255,255,0.09),0_16px_40px_rgba(0,0,0,0.7)] backdrop-blur-xl transition-all duration-500"
            style={{
              opacity: chrome ? 1 : 0,
              transform: `translate(-50%, ${chrome ? 0 : -10}px)`,
              pointerEvents: chrome ? "auto" : "none",
            }}
          >
          <span className="font-mono text-dim">›_</span>
          <span className="font-medium text-fg">{session?.name}</span>
          <span className="hidden font-mono text-dim sm:inline">
            {session?.host}
          </span>
          <button
            onClick={onClose}
            className="ml-1 flex items-center gap-2 rounded-full bg-white/[0.07] px-3 py-1 text-dim transition hover:bg-white/[0.12] hover:text-fg"
          >
            Workspace
            <kbd className="font-mono text-[10px] text-faint">Ctrl .</kbd>
          </button>
        </div>,
        document.body,
        )}
    </div>
  )
}
