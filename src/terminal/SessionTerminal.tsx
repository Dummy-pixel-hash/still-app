import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import {
  needsReattachMarker,
  noteTranscriptRendered,
  resizeSession,
  subscribeSessionData,
  transcriptSnapshot,
  writeSession,
} from "../session/connections"
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
  const lastDims = useRef({ cols: 0, rows: 0 })
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

    // Repaint recent transcript instantly (reconnect/reopen continuity).
    // The synthetic marker is painted only when the transcript GREW since
    // this surface last rendered it (bytes arrived while the overlay was
    // closed, e.g. across a disconnect/reconnect) — repeated opens of the
    // same live session repaint silently instead of stacking markers.
    const snapshot = transcriptSnapshot(localRef.current)
    if (snapshot.length > 0) {
      terminal.write(snapshot)
      if (needsReattachMarker(localRef.current)) {
        terminal.write("\r\n\x1b[90m[reattached — live output resumes below]\x1b[0m\r\n")
      }
      noteTranscriptRendered(localRef.current)
    }

    const pushResize = () => {
      try {
        fit.fit()
        const dims = fit.proposeDimensions()
        if (dims && dims.cols > 1 && dims.rows > 1) {
          // Skip no-op resizes: each push also repaints server-side, so
          // only notify when dims actually changed. First push always goes
          // through (lastCols/Rows start at 0) so attach gets real dims.
          if (dims.cols !== lastDims.current.cols || dims.rows !== lastDims.current.rows) {
            lastDims.current = { cols: dims.cols, rows: dims.rows }
            void resizeSession(localRef.current, dims.cols, dims.rows).catch(
              () => {},
            )
          }
        }
      } catch {
        // proposeDimensions can throw before first layout.
      }
    }
    pushResizeRef.current = pushResize

    // Keyboard -> SSH. xterm.js encodes Ctrl/Alt/arrows/F-keys itself.
    const dataDispose = terminal.onData((data) => {
      void writeSession(localRef.current, textEncoder.encode(data)).catch(
        () => {},
      )
    })

    let resizeTimer = 0
    const debounced = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(pushResize, 150)
    }
    const observer = new ResizeObserver(debounced)
    observer.observe(host)
    window.addEventListener("resize", debounced)

    // Initial size once laid out.
    const t = window.setTimeout(pushResize, 150)

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
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.code === "KeyC" &&
        event.type === "keydown"
      ) {
        event.preventDefault()
        event.stopPropagation()
        const selection = terminal.getSelection()
        if (selection) {
          if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(selection).catch(() => {
              const ta = document.createElement("textarea")
              ta.value = selection
              document.body.appendChild(ta)
              ta.select()
              try {
                document.execCommand("copy")
              } catch {
                // Selection stays visible for retry.
              }
              ta.remove()
            })
          }
        }
        return false
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.code === "KeyV" &&
        event.type === "keydown"
      ) {
        // One path only: terminal.paste() sends bracketed paste
        // (\x1b[200~...\x1b[201~) so apps see it as paste and never
        // auto-execute. Returning false stops xterm's own paste too.
        event.preventDefault()
        event.stopPropagation()
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) terminal.paste(text)
          })
          .catch(() => {})
        return false
      }
      return true
    })

    // Coalesce bursty SSH chunks into one term.write per frame.
    let pending: number[] = []
    let raf = 0
    const flush = () => {
      raf = 0
      if (pending.length === 0) return
      terminal.write(new Uint8Array(pending))
      pending = []
    }
    const unsub = subscribeSessionData(localRef.current, (data) => {
      pending.push(...data)
      if (!raf) raf = window.requestAnimationFrame(flush)
    })

    terminal.focus()

    return () => {
      window.clearTimeout(t)
      window.clearTimeout(resizeTimer)
      if (raf) window.cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener("resize", debounced)
      dataDispose.dispose()
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
      window.requestAnimationFrame(() => pushResizeRef.current())
    } catch {
      // Option applies best-effort only; never break the live session.
    }
  }, [prefs.fontSize, prefs.cursorStyle, prefs.scrollback])

  return (
    <div
      ref={hostRef}
      id={`still-term-${localRef.current}`}
      onClick={() => terminalRef.current?.focus()}
      className="h-full min-h-0 w-full cursor-text px-3 py-2 [&_.xterm]:h-full"
      aria-label="Terminal"
    />
  )
}

export { textDecoder }
