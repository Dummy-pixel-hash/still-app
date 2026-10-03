import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import {
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
  paused,
}: {
  localId: string
  prefs: TerminalPrefs
  paused?: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const localRef = useRef(localId)
  localRef.current = localId
  const pausedRef = useRef(paused ?? false)
  pausedRef.current = paused ?? false

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: prefs.cursorStyle,
      fontFamily: "'Geist Mono', ui-monospace, Consolas, monospace",
      fontSize: prefs.fontSize,
      lineHeight: 1.5,
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
    const snapshot = transcriptSnapshot(localRef.current)
    if (snapshot.length > 0) {
      terminal.write(snapshot)
      terminal.write("\r\n\x1b[90m[reattached — live output resumes below]\x1b[0m\r\n")
    }

    const pushResize = () => {
      if (pausedRef.current) return
      try {
        fit.fit()
        const dims = fit.proposeDimensions()
        if (dims && dims.cols > 1 && dims.rows > 1) {
          void resizeSession(localRef.current, dims.cols, dims.rows).catch(
            () => {},
          )
        }
      } catch {
        // proposeDimensions can throw before first layout.
      }
    }

    // Keyboard -> SSH. xterm.js encodes Ctrl/Alt/arrows/F-keys itself.
    const dataDispose = terminal.onData((data) => {
      if (pausedRef.current) return
      void writeSession(localRef.current, textEncoder.encode(data)).catch(
        () => {},
      )
    })

    let resizeTimer = 0
    const debounced = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(pushResize, 120)
    }
    const observer = new ResizeObserver(debounced)
    observer.observe(host)
    window.addEventListener("resize", debounced)

    // Initial size once laid out.
    const t = window.setTimeout(pushResize, 60)

    // Clipboard: Ctrl+Shift+C copies, Ctrl+Shift+V pastes.
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.code === "KeyC" &&
        event.type === "keydown"
      ) {
        const selection = terminal.getSelection()
        if (selection)
          void navigator.clipboard?.writeText(selection).catch(() => {})
        return false
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.code === "KeyV" &&
        event.type === "keydown"
      ) {
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text && !pausedRef.current)
              void writeSession(localRef.current, textEncoder.encode(text)).catch(
                () => {},
              )
          })
          .catch(() => {})
        return false
      }
      return true
    })

    const unsub = subscribeSessionData(localRef.current, (data) => {
      if (!pausedRef.current) terminal.write(new Uint8Array(data))
    })

    terminal.focus()

    return () => {
      window.clearTimeout(t)
      window.clearTimeout(resizeTimer)
      observer.disconnect()
      window.removeEventListener("resize", debounced)
      unsub()
      terminalRef.current = null
      fitRef.current = null
      terminal.dispose()
    }
    // Mount per overlay open: fresh surface, registry keeps the worker alive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={hostRef}
      onClick={() => terminalRef.current?.focus()}
      className="h-full min-h-0 w-full cursor-text px-3 py-2 [&_.xterm]:h-full"
      aria-label="Terminal"
    />
  )
}

export { textDecoder }
