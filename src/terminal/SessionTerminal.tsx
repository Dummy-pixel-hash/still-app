import { useCallback, useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
// GPU renderer: the DOM renderer (xterm's default without an addon) repaints
// fullscreen TUIs line-by-line, which is exactly the tearing seen when a
// coding agent redraws at speed. WebGL is dramatically faster; the DOM
// renderer takes over automatically if WebGL is unavailable or lost.
import { WebglAddon } from "@xterm/addon-webgl"
import "@xterm/xterm/css/xterm.css"
import {
  isTuiActive,
  needsReattachMarker,
  nativeSessionId,
  noteTranscriptRendered,
  refreshSession,
  resizeSession,
  subscribeSessionData,
  transcriptSnapshot,
  useConnections,
  writeSession,
} from "../session/connections"
import { nativeBridge } from "../bridge/nativeBridge"
import { bindTerminalClipboard } from "./clipboard"
import { bindApplicationWheel } from "./wheel"
import CustomScrollbar from "./CustomScrollbar"
import type { ImageInsertStyle, TerminalPrefs } from "../types"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * True when the byte window still contains a fullscreen enter sequence
 * (`CSI ? 1049/1047/1048 h`). Used to decide whether a ring-truncated
 * replay needs a synthetic alt-screen prefix.
 */
function snapshotHasAltEnter(bytes: Uint8Array): boolean {
  const text = textDecoder.decode(bytes)
  return /(?:\x1b\[\?1049h|\x1b\[\?1047h|\x1b\[\?1048h)/.test(text)
}

/**
 * Real session terminal surface, bound to a STABLE local session id.
 *
 * Data path:
 *   xterm.js onData (keyboard incl. Ctrl/arrows/F-keys)
 *     -> Tauri IPC still_write -> Rust worker input queue -> russh channel
 *   russh channel bytes -> Tauri window event -> connection registry
 *     -> this surface -> term.write()
 *   FitAddon.proposeDimensions -> still_resize -> russh window_change + tmux
 *
 * Raw bytes only — no interpretation, no shortcut layer above the terminal.
 * Leaving the overlay unmounts this surface but never disconnects: the
 * worker keeps running and the transcript repaints on reopen.
 */
export default function SessionTerminal({
  localId,
  prefs,
  imageInsertStyle,
  paused = false,
  onClose,
  onZoom,
}: {
  localId: string
  prefs: TerminalPrefs
  imageInsertStyle: ImageInsertStyle
  /** True while an auth dialog owns focus: input must not reach the PTY. */
  paused?: boolean
  onClose?: () => void
  onZoom?: (delta: number | "reset") => void
}) {
  useConnections()
  const transportId = nativeSessionId(localId)
  const [feedback, setFeedback] = useState("")
  const feedbackTimer = useRef(0)
  const notify = useCallback((message: string) => {
    setFeedback(message)
    window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => setFeedback(""), 4000)
  }, [])
  const hostRef = useRef<HTMLDivElement>(null)
  // FitAddon measures `.xterm`'s parent's border-box, so the terminal is
  // opened into a padding-free inner div: with any host side padding the
  // fit would see a wider box than the real content, overfit and overflow
  // right — i.e. a wider gap on the left than on the right. Side padding
  // is zero so the visible gap matches the 8px top: the centered screen
  // always keeps >=3px from the edge (half of FitAddon's 6px scrollbar
  // lane reserve).
  const fitHostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  // Rendered into CustomScrollbar once the surface exists; nulled on unmount.
  const [terminal, setTerminal] = useState<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const localRef = useRef(localId)
  localRef.current = localId
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onZoomRef = useRef(onZoom)
  onZoomRef.current = onZoom
  // Live read for the image-insert style: the clipboard binding mounts once,
  // so it reads through this ref to always honor the current Settings value.
  const insertStyleRef = useRef(imageInsertStyle)
  insertStyleRef.current = imageInsertStyle
  // While an auth dialog is open (paused), every INPUT path — keyboard,
  // binary, wheel reports, pastes — must stop at this surface. Remote
  // output keeps rendering: pausing writes froze the screen (the old
  // pre-refactor behavior) without adding any safety.
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  // Last dims pushed server-side; skips redundant resize traffic.
  const lastDims = useRef({ nativeId: null as string | null, cols: 0, rows: 0 })
  // Hoisted resizer so font changes can re-push dims (see prefs effect).
  const pushResizeRef = useRef<() => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    const fitHost = fitHostRef.current
    if (!host || !fitHost) return

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: prefs.cursorStyle,
      fontFamily:
        "'Geist Mono', ui-monospace, Consolas, 'Segoe UI Emoji', 'Noto Color Emoji', 'Apple Color Emoji', monospace",
      fontSize: prefs.fontSize,
      lineHeight: 1.2,
      scrollback: prefs.scrollback,
      // Smooth viewport animation for local scrollback (normal buffer,
      // zero IPC). 160ms is quick enough to stay responsive on a mouse
      // wheel; xterm ignores it for raw trackpad momentum streams
      // (xtermjs#4412), which already scroll per-frame.
      smoothScrollDuration: 160,
      scrollSensitivity: 1,
      fastScrollSensitivity: 4,
      // Reserves exactly the custom thumb's 6px lane (instead of the 14px
      // stock scrollbar) so FitAddon reclaims the rest for columns.
      overviewRuler: { width: 6 },
      theme: {
        background: "#08080a",
        foreground: "#ded9dd",
        cursor: "#ff5a5a",
        cursorAccent: "#08080a",
        selectionBackground: "#8f2a2a66",
        // Stock bars are hidden (theme.css + CustomScrollbar); keep the
        // built-in slider/ruler permanently unpainted as a backstop.
        scrollbarSliderBackground: "rgba(0,0,0,0)",
        scrollbarSliderHoverBackground: "rgba(0,0,0,0)",
        scrollbarSliderActiveBackground: "rgba(0,0,0,0)",
        overviewRulerBorder: "#00000000",
        black: "#08080a",
        brightBlack: "#777078",
        red: "#ff5a5a",
        brightRed: "#ff7777",
        green: "#91b587",
        brightGreen: "#acd19f",
        yellow: "#d5aa82",
        brightYellow: "#e7bf98",
        blue: "#9a96b8",
        brightBlue: "#b3afd0",
        magenta: "#b89ab8",
        brightMagenta: "#cdb0cd",
        cyan: "#8eadb2",
        brightCyan: "#a5c4c9",
        white: "#d7d2d6",
        brightWhite: "#f4f0f2",
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    // Unicode 11 width rules: emoji/CJK that are double-width in newer
    // Unicode render as a full 2-cell glyph instead of being measured as
    // 1 cell and getting its right half overwritten / clipped.
    const unicode11 = new Unicode11Addon()
    terminal.loadAddon(unicode11)
    terminal.unicode.activeVersion = "11"
    terminal.open(fitHost)
    terminalRef.current = terminal
    setTerminal(terminal)
    fitRef.current = fit

    // GPU rendering for the main surface only (never the small card
    // previews — WebGL context limits). On context loss the addon must be
    // disposed so xterm falls back to its DOM renderer instead of freezing.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        try {
          webgl.dispose()
        } catch {
          // Already torn down by the browser.
        }
      })
      terminal.loadAddon(webgl)
    } catch {
      // No WebGL2 in this WebView: the DOM renderer still works, just slower.
    }

    const clipboard = bindTerminalClipboard({
      terminal,
      host,
      bridge: () => nativeBridge,
      sessionId: () => nativeSessionId(localRef.current),
      sessionLocalId: () => localRef.current,
      insertStyle: () => insertStyleRef.current,
      notify,
      write: (bytes) => {
        // Paste input: dropped while auth is paused (see sendInput).
        if (pausedRef.current) return Promise.resolve()
        return writeSession(localRef.current, bytes)
      },
    })
    // Repaint only remote bytes. App notices must not move the TUI cursor,
    // and replayed OSC 52 sequences must never stage an old clipboard copy.
    const snapshot = transcriptSnapshot(localRef.current)
    if (snapshot.length > 0) {
      // The ring keeps the LAST 64KB: if the transcript is a fullscreen TUI
      // whose alt-screen enter (`?1049h`) was evicted, a raw replay paints
      // cursor-addressed redraw fragments into the NORMAL screen — the
      // "breaks into lines" glitch. In that case prefix a synthetic
      // enter+clear so the fragments land on a clean alt screen and the
      // next redraws reassemble correctly. When the enter survived, replay
      // raw so xterm enters alt screen naturally.
      let payload: Uint8Array
      if (isTuiActive(localRef.current) && !snapshotHasAltEnter(snapshot)) {
        // `ESC[?1049h ESC[2J ESC[H`: enter alt screen, clear it, home.
        const prefix = textEncoder.encode("\x1b[?1049h\x1b[2J\x1b[H")
        payload = new Uint8Array(prefix.length + snapshot.length)
        payload.set(prefix, 0)
        payload.set(snapshot, prefix.length)
      } else {
        payload = snapshot
      }
      terminal.write(payload, () => {
        clipboard.endReplay()
        // Remount: the ring replay is a lossy approximation of a TUI frame
        // (cursor-addressed redraws, possibly evicted alt-screen enters),
        // and tmux — whose client never detached — sees no size change, so
        // it would never repaint. Ask it to resend the authoritative screen;
        // its bytes arrive after this write and supersede the fragments.
        const id = localRef.current
        void refreshSession(id).catch(() => {
          // Keep the replay; a missing repaint is the old behavior.
        })
      })
      if (needsReattachMarker(localRef.current)) notify("Session reattached")
      noteTranscriptRendered(localRef.current)
    } else {
      clipboard.endReplay()
    }

    const pushResize = () => {
      try {
        fit.fit()
        const dims = fit.proposeDimensions()
        if (dims && dims.cols > 1 && dims.rows > 1) {
          // Skip no-op resizes: each push also repaints server-side, so
          // only notify when dims actually changed. First push always goes
          // through (lastCols/Rows start at 0) so attach gets real dims.
          const nativeId = nativeSessionId(localRef.current)
          if (nativeId && (nativeId !== lastDims.current.nativeId || dims.cols !== lastDims.current.cols || dims.rows !== lastDims.current.rows)) {
            const sent = { nativeId, cols: dims.cols, rows: dims.rows }
            lastDims.current = sent
            void resizeSession(localRef.current, dims.cols, dims.rows).catch(() => {
              if (lastDims.current === sent) lastDims.current = { nativeId: null, cols: 0, rows: 0 }
            })
          }
        }
      } catch {
        // proposeDimensions can throw before first layout.
      }
    }
    pushResizeRef.current = pushResize

    // One IPC write per wheel gesture, not one per generated mouse report.
    // Ordinary keyboard/paste input remains immediate and in byte order.
    // Auth-paused: everything is dropped — while the dialog owns focus, no
    // keystroke (typed, pasted, or wheel-generated) may reach the PTY.
    let inputBatch: Uint8Array[] | null = null
    const sendInput = (bytes: Uint8Array) => {
      if (pausedRef.current) return
      if (inputBatch) inputBatch.push(bytes)
      else void writeSession(localRef.current, bytes).catch(() => {})
    }
    const dataDispose = terminal.onData(data => sendInput(textEncoder.encode(data)))
    const binaryDispose = terminal.onBinary(data =>
      sendInput(Uint8Array.from(data, c => c.charCodeAt(0) & 255)),
    )
    const unbindWheel = bindApplicationWheel(terminal, host, dispatch => {
      const chunks: Uint8Array[] = []
      inputBatch = chunks
      try {
        dispatch()
      } finally {
        inputBatch = null
        const length = chunks.reduce((n, chunk) => n + chunk.length, 0)
        if (length) {
          const bytes = new Uint8Array(length)
          let offset = 0
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
          sendInput(bytes)
        }
      }
    })

    let resizeTimer = 0
    const debounced = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(pushResize, 150)
    }
    const observer = new ResizeObserver(debounced)
    observer.observe(host)
    window.addEventListener("resize", debounced)

    // Initial fit on the next layout frame; nativeId changes trigger another
    // push below so a pre-connect fit cannot swallow the first real resize.
    const t = window.requestAnimationFrame(pushResize)

    // Webfonts (Geist Mono) can land after the first fit: cell metrics then
    // change and the already-fitted grid overflows or leaves the screen
    // off-center. Re-fit once fonts settle; xterm itself doesn't.
    let disposed = false
    const refitOnFonts = () => {
      if (!disposed) debounced()
    }
    document.fonts?.ready?.then(refitOnFonts).catch(() => {})
    document.fonts?.addEventListener?.("loadingdone", refitOnFonts)

    // Backstop only: the overlay's capture-phase gate owns shortcuts and
    // stops them before xterm sees them. This covers the case where the
    // gate unmounted but the surface lingers.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.ctrlKey && !event.metaKey && !event.altKey) {
        const t = event.target as HTMLElement | null
        const inXterm = !!t && !!t.classList?.contains("xterm-helper-textarea")
        const inField = !!t && !inXterm && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
        const k = event.key.toLowerCase()
        const isClose = event.code === "Period" || k === "." || k === ">"
        const isZoom = ["Minus", "Equal", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"].includes(event.code) || ["-", "_", "=", "+", "0"].includes(k)
        if (isClose || (isZoom && !inField)) {
          event.preventDefault()
          event.stopPropagation()
          if (isClose) onCloseRef.current?.()
          else onZoomRef.current?.(k === "0" ? "reset" : k === "-" || k === "_" ? -1 : 1)
          return false
        }
      }
      return true
    })

    // xterm already queues parsing/rendering. An additional per-frame output
    // queue added latency and grew without bound in a background WebView.
    const unsub = subscribeSessionData(localRef.current, (data) => {
      terminal.write(Uint8Array.from(data))
    })

    // Do not grab focus while an auth dialog (or any outer modal) owns it.
    if (!paused) terminal.focus()

    return () => {
      disposed = true
      window.cancelAnimationFrame(t)
      window.clearTimeout(resizeTimer)
      window.clearTimeout(feedbackTimer.current)
      observer.disconnect()
      window.removeEventListener("resize", debounced)
      document.fonts?.removeEventListener?.("loadingdone", refitOnFonts)
      clipboard.dispose()
      unbindWheel()
      dataDispose.dispose()
      binaryDispose.dispose()
      pushResizeRef.current = () => {}
      unsub()
      // Remember how much transcript this surface rendered, so the next
      // mount can tell growth (marker) from a plain reopen (silent repaint).
      noteTranscriptRendered(localRef.current)
      terminalRef.current = null
      setTerminal(null)
      fitRef.current = null
      terminal.dispose()
    }
    // Mount per overlay open: fresh surface, registry keeps the worker alive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply preference changes live: the mount effect above reads prefs once,
  // so without this, font/cursor/scrollback edits only take effect after
  // closing + reopening the overlay.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    try {
      if (terminal.options.fontSize !== prefs.fontSize) {
        terminal.options.fontSize = prefs.fontSize
      }
      if (terminal.options.cursorStyle !== prefs.cursorStyle) {
        terminal.options.cursorStyle = prefs.cursorStyle
      }
      if (terminal.options.scrollback !== prefs.scrollback) {
        terminal.options.scrollback = prefs.scrollback
      }
      // Re-fit AND re-push (next frame, after xterm lays out the new
      // font): smaller font fits more cols/rows, so the server must be
      // told or tmux keeps drawing the old grid.
      const frame = window.requestAnimationFrame(() => pushResizeRef.current())
      return () => window.cancelAnimationFrame(frame)
    } catch {
      // Option applies best-effort only; never break the live session.
    }
  }, [prefs.fontSize, prefs.cursorStyle, prefs.scrollback, transportId])

  // Auth un-pause: when the dialog closes, return focus to the terminal.
  // (Pausing never blurs an already-blurred terminal; un-pausing must give
  // the user typing straight back.)
  useEffect(() => {
    if (!paused && terminalRef.current) terminalRef.current.focus()
  }, [paused])

  return (
    <div
      ref={hostRef}
      onClick={() => {
        // While paused (auth dialog open), clicking the terminal must not
        // steal focus from the dialog's password/key field.
        if (!pausedRef.current) terminalRef.current?.focus()
      }}
      className="relative h-full min-h-0 w-full cursor-text px-0 py-2 [&_.xterm]:h-full"
      aria-label="Terminal"
    >
      {/* Padding-free: FitAddon measures this div's border-box, so any
          padding here would make it overfit and push the grid off-center. */}
      <div ref={fitHostRef} id={`still-term-${localRef.current}`} className="h-full w-full" />
      <CustomScrollbar terminal={terminal} />
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute bottom-3 left-4 right-4 z-10 text-sm text-fg"
      >
        {feedback && <span className="inline-block rounded-md bg-[#17171a] px-3 py-2">{feedback}</span>}
      </div>
    </div>
  )
}

export { textDecoder }
