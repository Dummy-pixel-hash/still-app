import { useCallback, useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import {
  needsReattachMarker,
  nativeSessionId,
  noteTranscriptRendered,
  resizeSession,
  subscribeSessionData,
  transcriptSnapshot,
  useConnections,
  writeSession,
} from "../session/connections"
import { nativeBridge } from "../bridge/nativeBridge"
import { bindTerminalClipboard } from "./clipboard"
import { bindApplicationWheel } from "./wheel"
import type { TerminalPrefs } from "../types"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

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
  onClose,
  onZoom,
}: {
  localId: string
  prefs: TerminalPrefs
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
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const localRef = useRef(localId)
  localRef.current = localId
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onZoomRef = useRef(onZoom)
  onZoomRef.current = onZoom
  // Last dims pushed server-side; skips redundant resize traffic.
  const lastDims = useRef({ nativeId: null as string | null, cols: 0, rows: 0 })
  // Hoisted resizer so font changes can re-push dims (see prefs effect).
  const pushResizeRef = useRef<() => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: prefs.cursorStyle,
      fontFamily: "'Geist Mono', ui-monospace, Consolas, monospace",
      fontSize: prefs.fontSize,
      lineHeight: 1.0,
      scrollback: prefs.scrollback,
      theme: {
        background: "#08080a",
        foreground: "#ded9dd",
        cursor: "#ff5a5a",
        cursorAccent: "#08080a",
        selectionBackground: "#8f2a2a66",
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
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit

    const clipboard = bindTerminalClipboard({
      terminal,
      host,
      bridge: () => nativeBridge,
      sessionId: () => nativeSessionId(localRef.current),
      notify,
      write: (bytes) => writeSession(localRef.current, bytes),
    })
    // Repaint only remote bytes. App notices must not move the TUI cursor,
    // and replayed OSC 52 sequences must never stage an old clipboard copy.
    const snapshot = transcriptSnapshot(localRef.current)
    if (snapshot.length > 0) {
      terminal.write(snapshot, clipboard.endReplay)
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
    let inputBatch: Uint8Array[] | null = null
    const sendInput = (bytes: Uint8Array) => {
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

    terminal.focus()

    return () => {
      window.cancelAnimationFrame(t)
      window.clearTimeout(resizeTimer)
      window.clearTimeout(feedbackTimer.current)
      observer.disconnect()
      window.removeEventListener("resize", debounced)
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

  return (
    <div
      ref={hostRef}
      id={`still-term-${localRef.current}`}
      onClick={() => terminalRef.current?.focus()}
      className="relative h-full min-h-0 w-full cursor-text px-3 py-2 [&_.xterm]:h-full"
      aria-label="Terminal"
    >
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
