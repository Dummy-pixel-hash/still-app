import type { Terminal } from "@xterm/xterm"
import type { NativeBridge } from "../bridge/nativeBridge"

export const MAX_REMOTE_COPY_BYTES = 1024 * 1024

/** OSC 52 write only: never answer a remote clipboard read/query. */
export function decodeClipboardRequest(data: string): string | null {
  const separator = data.indexOf(";")
  if (separator < 0) return null
  const target = data.slice(0, separator)
  const encoded = data.slice(separator + 1)
  if ((target !== "" && target !== "c") || encoded === "?" || !encoded.length) return null
  if (encoded.length > Math.ceil(MAX_REMOTE_COPY_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null
  try {
    const binary = atob(encoded)
    if (binary.length > MAX_REMOTE_COPY_BYTES) return null
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)))
  } catch {
    return null
  }
}

/** Local copy and explicit, bounded TUI clipboard transfers share one shortcut. */
export function bindTerminalClipboard({ terminal, host, bridge, sessionId, notify }: {
  terminal: Terminal
  host: HTMLElement
  bridge: () => NativeBridge
  sessionId: () => string | null
  notify: (message: string) => void
}) {
  let alive = true
  let replaying = true
  let copying = false
  let pasting = false
  let owner = sessionId()
  let remoteCopy: { text: string; time: number } | null = null
  const syncOwner = () => {
    const current = sessionId()
    if (current !== owner) { owner = current; remoteCopy = null }
    return current
  }
  const osc = terminal.parser.registerOscHandler(52, (data) => {
    syncOwner()
    if (!replaying && owner !== null) {
      const text = decodeClipboardRequest(data)
      if (text !== null) {
        remoteCopy = { text, time: Date.now() }
        notify("TUI selection ready — Ctrl+Shift+C to copy")
      }
    }
    // Consume unsupported/read requests too, without consulting the OS clipboard.
    return true
  })

  const copy = async () => {
    syncOwner()
    const selected = terminal.getSelection()
    const pending = remoteCopy && Date.now() - remoteCopy.time < 30_000 ? remoteCopy : null
    const text = selected || pending?.text
    if (!text) {
      notify("Nothing selected. Hold Shift and drag over text, then Ctrl+Shift+C.")
      return
    }
    if (copying) return
    copying = true
    try {
      await bridge().clipboardWriteText(text)
      if (alive) {
        if (remoteCopy === pending) remoteCopy = null
        notify(selected ? "Copied selection" : "Copied TUI selection")
      }
    } catch {
      if (alive) notify("Copy failed. Clipboard access was denied; try Ctrl+Shift+C again.")
    } finally {
      copying = false
    }
  }
  const paste = async () => {
    if (pasting) return
    const targetSession = syncOwner()
    if (!targetSession) { notify("Connect before pasting."); return }
    pasting = true
    try {
      const text = await bridge().clipboardReadText()
      // A pending permission/read result must not paste into a new session or dialog.
      if (alive && targetSession === syncOwner() && host.contains(document.activeElement)) {
        if (text) terminal.paste(text)
      }
    } catch {
      if (alive) notify("Paste failed. Clipboard access was denied; use the paste menu or retry.")
    } finally {
      pasting = false
    }
  }
  const onKey = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.isComposing) return
    const key = event.key.toLowerCase()
    const isCopy = event.code === "KeyC" || key === "c"
    const isPaste = event.code === "KeyV" || key === "v"
    if (!isCopy && !isPaste) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.repeat) return
    if (isCopy) void copy()
    else void paste()
  }
  host.addEventListener("keydown", onKey, { capture: true })
  return {
    endReplay: () => { replaying = false },
    dispose: () => {
      alive = false
      remoteCopy = null
      osc.dispose()
      host.removeEventListener("keydown", onKey, { capture: true })
    },
  }
}
