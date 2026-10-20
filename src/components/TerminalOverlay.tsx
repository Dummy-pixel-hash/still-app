import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import SessionTerminal from "../terminal/SessionTerminal"
import {
  TERMINAL_CELL_W_RATIO,
  TERMINAL_LINE_HEIGHT,
  clearHostKeyPrompt,
  connectionError,
  connectionState,
  disconnectSession,
  forgetStoredHostKey,
  hostKeyPromptFor,
  isConnectPending,
  reconnectSession,
  noteSurfaceFontSize,
  useConnections,
  type ConnectRequest,
} from "../session/connections"
import { nativeBridge } from "../bridge/nativeBridge"
import { updateTerminalPrefs } from "../session/store"
import type { ImageInsertStyle, Session, TerminalPrefs } from "../types"

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
/** Card→fullscreen morph duration. Kept in one place: the CSS transition,
 *  the `settled` gate below, and Workspace's close timer must agree. */
export const MORPH_MS = 650
export interface OpenState {
  session: Session
  rect: DOMRect
  phase: "enter" | "open" | "exit"
  /** Companion activation observes an existing session; never reconnects it. */
  autoConnect?: boolean
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
  prefs,
  imageInsertStyle,
  keyTextFor,
  onClose,
  onNeedAuth,
  slot,
  dockStyle,
}: {
  open: OpenState | null
  prefs: TerminalPrefs
  imageInsertStyle: ImageInsertStyle
  keyTextFor: (keyId: string) => string | null
  // slot docks an overlay beside main ("left"); temp tiles keep "right" for
  // the overlay-root gate but are positioned by dockStyle instead.
  slot?: "left" | "right"
  // dockStyle positions an overlay when manually docked (temp tiles). Takes
  // priority over slot once the overlay is mounted; slot stays for the data
  // gate and the main overlay's "left" half.
  dockStyle?: React.CSSProperties
  onClose: () => void
  onNeedAuth: (
    session: Session,
  ) => Promise<{ secret?: string; remember: boolean } | null>
}) {
  useConnections()
  const full = open?.phase === "open"
  // The overlay morphs from the card rect to fullscreen over 650ms
  // (transition-all below). Mounting the terminal + first connect during
  // that morph attaches tmux at the small card grid and then resizes it
  // repeatedly as the host grows — TUIs reflow mid-draw and tear. Gate
  // both on `settled`: the morph has finished, the host has its final
  // size, and the first fit/attach is the only resize the server sees.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!full) {
      setSettled(false)
      return
    }
    // Reduced motion zeroes the CSS transition; waiting the morph out would
    // hand those users a blank overlay for ~0.7s on every open.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    const t = window.setTimeout(() => setSettled(true), reduced ? 0 : MORPH_MS + 30)
    return () => window.clearTimeout(t)
  }, [full])
  const [chrome, setChrome] = useState(true)
  const hide = useRef(0)
  const [prompt, setPrompt] = useState<AuthPrompt | null>(null)
  // True while an auth dialog for this overlay is pending (BUG 3 guard:
  // the terminal must not swallow keystrokes while the auth dialog owns
  // focus). Passes down as `paused`: blocks keyboard/paste/wheel input and
  // focus stealing, but keeps remote output rendering — the screen must
  // never freeze (that's what the old write-pausing got wrong).
  const [authOpen, setAuthOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Footer starts collapsed: one slim status line, buttons one tap away.
  const [footerOpen, setFooterOpen] = useState(false)
  const session = open?.session ?? null
  const localId = session?.id ?? ""
  const state = session ? connectionState(session.id) : "disconnected"
  const lastError = session ? connectionError(session.id) : null
  // M5: pending untrusted-host prompt (fingerprint Trust/Reject). The worker
  // refused BEFORE auth; trust is an explicit user action, persisted by Rust.
  const hostPrompt = session ? hostKeyPromptFor(session.id) : null
  const [trustBusy, setTrustBusy] = useState(false)
  const [forgetBusy, setForgetBusy] = useState(false)
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
  const forgetStoredKey = useCallback(async () => {
    if (!session || !hostPrompt || forgetBusy) return
    setForgetBusy(true)
    try {
      // Changed-key recovery only: remove the STORED old key, nothing else.
      // The replacement is never trusted here — the next connect re-enters
      // the normal unknown-host flow and still requires explicit Trust.
      await forgetStoredHostKey(session.id, hostPrompt.host, hostPrompt.port)
    } catch (e) {
      // Leave the prompt up; the registry keeps the changed-key error.
      console.error("forgetHost refused:", e)
    } finally {
      setForgetBusy(false)
    }
  }, [session, hostPrompt, forgetBusy])

  const show = useCallback((ms = 2000) => {
    setChrome(true)
    window.clearTimeout(hide.current)
    hide.current = window.setTimeout(() => setChrome(false), ms)
  }, [])

  useEffect(() => {
    if (full) show(2800)
    return () => window.clearTimeout(hide.current)
  }, [full, show])

  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Single capture-phase gate: runs before xterm sees the key, so app
  // shortcuts never leak bytes into the PTY. Backstop lives in
  // SessionTerminal's attachCustomKeyEventHandler for focused-terminal.
  // Two overlays mounted? A key inside the other overlay isn't ours.
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const other = t?.closest?.("[data-overlay-root]")
      if (other && !rootRef.current?.contains(t as Node)) return
      // Temp dock controls are siblings, not part of any overlay. Escape
      // there must not close every overlay in the dock at once.
      if (t?.closest?.("[data-temp-dock]")) return
      // Plain Escape (no modifiers) closes the overlay. The terminal only
      // sees this when it is not the focused surface: xterm exits its own
      // mouse/focus modes with Escape and needs to keep receiving it.
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (t?.closest?.(".xterm")) return
        e.preventDefault()
        onClose()
        return
      }
      if (!e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      const isClose = e.code === "Period" || k === "." || k === ">"
      const isReset =
        k === "0" || e.code === "Digit0" || e.code === "Numpad0"
      const isZoomOut =
        k === "-" ||
        k === "_" ||
        e.code === "Minus" ||
        e.code === "NumpadSubtract"
      const isZoomIn =
        k === "=" ||
        k === "+" ||
        e.code === "Equal" ||
        e.code === "NumpadAdd"
      if (!isClose && !isReset && !isZoomOut && !isZoomIn) return
      const inXterm = !!t && !!t.classList?.contains("xterm-helper-textarea")
      const inField =
        !!t &&
        !inXterm &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      // Close works everywhere (even mid-auth); zoom skips text fields.
      if (inField && !isClose) return
      e.preventDefault()
      e.stopPropagation()
      if (isClose) {
        onClose()
        return
      }
      const cur = prefsRef.current.fontSize
      if (isReset) updateTerminalPrefs({ fontSize: 14 })
      else if (isZoomOut)
        updateTerminalPrefs({ fontSize: Math.max(10, cur - 1) })
      else updateTerminalPrefs({ fontSize: Math.min(24, cur + 1) })
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [full, onClose])

  // Wrap the auth dialog so the overlay can pause terminal input for
  // exactly the dialog's lifetime (mount -> resolve/cancel), never longer.
  const askAuth = useCallback(
    async (s: Session): Promise<{ secret?: string; remember: boolean } | null> => {
      setAuthOpen(true)
      try {
        return await onNeedAuth(s)
      } finally {
        setAuthOpen(false)
      }
    },
    [onNeedAuth],
  )

  const buildRequest = useCallback(
    async (s: Session): Promise<ConnectRequest | null> => {
      // Attach with the overlay's REAL dims on first try instead of a
      // hardcoded 80x24-then-correct: TUIs that draw in the first window
      // lay out for the wrong size and reflow glitchily. Falls back to
      // 80x24 only if the terminal surface isn't laid out yet.
      let dims = { cols: 80, rows: 24 }
      try {
        const host = document.getElementById(`still-term-${s.id}`)
        if (host && host.clientWidth > 0 && host.clientHeight > 0) {
      // Mirror FitAddon's math on the padding-free host so the first
      // attach matches the first real fit exactly (no reflow correction):
      // Geist Mono 14px = 8.4x19 cells, minus the 6px custom-scrollbar
      // lane it subtracts when scrollback > 0. Cell metrics scale ~linearly
      // with the configured font size.
      const fontPx = prefs.fontSize
      noteSurfaceFontSize(fontPx)
      const cellW = TERMINAL_CELL_W_RATIO * fontPx
      const cellH = TERMINAL_LINE_HEIGHT * fontPx
      dims = {
        cols: Math.max(20, Math.min(500, Math.floor((host.clientWidth - 6) / cellW))),
        rows: Math.max(5, Math.min(200, Math.floor(host.clientHeight / cellH))),
      }
        }
      } catch {
        // Fall back to 80x24.
      }
      const base = {
        localId: s.id,
        host: s.host,
        port: s.port,
        username: s.username,
        tmuxSession: s.tmuxSession,
        workingDirectory: s.workingDirectory,
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
        const ans = await askAuth(s)
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
        const ans = await askAuth(s)
        if (!ans) return null
        return {
          ...base,
          authKind: "privateKey" as const,
          secret: ans.secret,
          remember: ans.remember,
        }
      }
      // ask: prompt every time, transient only.
      const ans = await askAuth(s)
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
    [askAuth, keyTextFor, prompt, prefs],
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
    } catch (e) {
      // connectSession records failures in the registry (error state), but
      // stay rejection-safe here too: no unhandled promise rejections from
      // any button, and the error panel (not the terminal) shows the cause.
      console.error("connect failed:", e)
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
  // Single-owner rule: a connect attempt owned elsewhere (e.g. the creation
  // flow's direct connect, which already carries the freshly typed secret)
  // is already in flight or resolved by the time the overlay opens — the
  // registry tracks it via isConnectPending, and any non-disconnected state
  // means this overlay must NOT start a second attempt. No delays involved.
  const autoTried = useRef<string | null>(null)
  useEffect(() => {
    if (open?.autoConnect !== false && settled && full && session && connectionState(session.id) === "disconnected" && !isConnectPending(session.id) && !busy && autoTried.current !== session.id) {
      autoTried.current = session.id
      void doConnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  const touch = useRef<number | null>(null)
  const r = open?.rect
  // Docked slot: half-width split. Main left, temp right with a 1px gap.
  const docked = slot && full
  const style: React.CSSProperties =
    dockStyle && full
      ? { borderRadius: 8, ...dockStyle }
      : docked
        ? slot === "left"
          ? { top: 0, left: 0, width: "calc(50vw - 1px)", height: "100vh", borderRadius: 8 }
          : { top: 0, left: "calc(50vw + 1px)", width: "calc(50vw - 1px)", height: "100vh", borderRadius: 8 }
        : full
          ? { top: 0, left: 0, width: "100vw", height: "100vh", borderRadius: 8 }
          : {
              top: r?.top ?? 0,
              left: r?.left ?? 0,
              width: r?.width ?? 0,
              height: r?.height ?? 0,
              borderRadius: 8,
            }

  return (
    <div
      ref={rootRef}
      data-overlay-root={slot ?? "solo"}
      className={`fixed z-50 overflow-hidden bg-[#08080a] transition-[top,left,width,height,border-radius,opacity] duration-[650ms] ${
        !open ? "hidden" : ""
      }`}
      role={open ? "dialog" : undefined}
      aria-modal={open ? true : undefined}
      aria-label={open ? `${open.session.name} terminal` : undefined}
      aria-hidden={!open}
      style={{
        ...style,
        transitionTimingFunction: EASE,
        // 1px edge definition in both states: on a transparent rounded
        // window the terminal surface would otherwise melt into the
        // desktop behind it.
        boxShadow: "0 0 0 1px rgba(255,255,255,0.08)",
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
      {/* Always-on grab strip: pill auto-hides, this never does. */}
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-40 h-2 cursor-default"
        aria-hidden
      />
      <div
        className="relative h-full w-full transition-opacity"
        style={{
          opacity: full ? 1 : 0,
          transitionDuration: full ? "600ms" : "150ms",
          transitionDelay: full ? "350ms" : "0ms",
        }}
      >
        {open && full && settled ? (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <SessionTerminal
                key={`${open.session.id}-${open.session.updatedAt}`}
                localId={open.session.id}
                prefs={prefs}
                imageInsertStyle={imageInsertStyle}
                paused={authOpen}
                onClose={onClose}
                onZoom={(d) =>
                  updateTerminalPrefs({
                    fontSize:
                      d === "reset"
                        ? 14
                        : Math.min(24, Math.max(10, prefs.fontSize + d)),
                  })
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
                {hostPrompt.changed && (
                  <p className="font-mono text-[11px] text-amber-200/90">
                    If you verified the change out-of-band, remove the stored key,
                    then Retry to review the new key as unknown — Trust is still required.
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
                  {hostPrompt.changed && (
                    <button
                      type="button"
                      disabled={forgetBusy}
                      onClick={() => void forgetStoredKey()}
                      className="rounded-full bg-amber-400 px-4 py-1.5 text-[12px] font-semibold text-black transition hover:bg-amber-300 disabled:opacity-50"
                    >
                      {forgetBusy ? "Removing…" : "Remove stored key"}
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
            {state === "connecting" && (
              <div className="flex shrink-0 items-center gap-2 border-t border-white/[0.07] bg-black/60 px-4 py-2">
                <button
                  type="button"
                  onClick={() => setFooterOpen((v) => !v)}
                  aria-label={footerOpen ? "Collapse status bar" : "Expand status bar"}
                  className="flex items-center gap-2 rounded-full px-1 py-0.5 outline-none transition hover:bg-white/[0.06]"
                >
                  <span
                    className="h-[7px] w-[7px] animate-pulse rounded-full bg-[#e8c4a0]"
                  />
                  <span className="font-mono text-[11px] text-dim">
                    {hostPrompt
                      ? "waiting for approval…"
                      : "connecting…"}
                  </span>
                  <span className="font-mono text-[10px] text-faint">
                    {footerOpen ? "▾" : "▸"}
                  </span>
                </button>
                {footerOpen && (
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
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {full &&
        createPortal(
          <div
            data-tauri-drag-region
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
