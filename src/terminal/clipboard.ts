import type { Terminal } from "@xterm/xterm"
import { readClipboardImageFile } from "../bridge/nativeBridge"
import type { NativeBridge } from "../bridge/nativeBridge"

export const MAX_REMOTE_COPY_BYTES = 1024 * 1024

/** Max clipboard image accepted for remote upload (5 MiB raw). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Remote directory receiving pasted images (created on demand). */
export const IMAGE_UPLOAD_DIR = "$HOME/still-uploads"

const IMAGE_EOF = "STILL_IMAGE_EOF"

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
export function imageUploadFileName(now: Date, mime: string): string {
  const ext =
    mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png"
  const stamp = now.toISOString().replace(/[:.]/g, "-")
  return `still-paste-${stamp}.${ext}`
}

/** Remote path for an uploaded paste (always inside IMAGE_UPLOAD_DIR). */
export function imageRemotePath(fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_") || "still-paste.png"
  return `${IMAGE_UPLOAD_DIR}/${safe}`
}

/**
 * Shell script that recreates `base64` bytes at `remotePath` on the REMOTE
 * host using only POSIX coreutils (no SFTP channel needed). Sent through the
 * existing PTY input path, so it lands in the shell exactly like typed text.
 * Base64 output is heredoc-safe (no quotes/backticks/dollars by construction).
 */
export function buildImageUploadScript(remotePath: string, base64: string): string {
  const quoted = `"${remotePath.replace(/"/g, '\\"')}"`
  return `mkdir -p ${IMAGE_UPLOAD_DIR} && base64 -d > ${quoted} <<'${IMAGE_EOF}'\n${base64}\n${IMAGE_EOF}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result ?? "")
      const comma = url.indexOf(",")
      if (comma < 0 || !url.startsWith("data:")) {
        reject(new Error("unreadable image"))
        return
      }
      resolve(url.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error("unreadable image"))
    reader.readAsDataURL(blob)
  })
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
  const pasteImage = async (blob: Blob) => {
    if (pasting) return
    const targetSession = syncOwner()
    if (!targetSession) { notify("Connect before pasting."); return }
    if (!blob.type.startsWith("image/")) {
      notify("Only images can be pasted as files.")
      return
    }
    if (blob.size > MAX_IMAGE_BYTES) {
      notify(`Image too large (${formatBytes(blob.size)}). Max is ${formatBytes(MAX_IMAGE_BYTES)}.`)
      return
    }
    pasting = true
    try {
      const base64 = await blobToBase64(blob)
      const remotePath = imageRemotePath(imageUploadFileName(new Date(), blob.type))
      const script = buildImageUploadScript(remotePath, base64)
      // A pending read must not paste into a new session or dialog.
      if (alive && targetSession === syncOwner() && host.contains(document.activeElement)) {
        terminal.paste(`${script}\n`)
        notify(`Pasted image → ${remotePath} (${formatBytes(blob.size)})`)
      }
    } catch {
      if (alive) notify("Image paste failed. Try copying the file another way.")
    } finally {
      pasting = false
    }
  }
  const onKey = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.isComposing) return
    const key = event.key.toLowerCase()
    const isCopy = event.code === "KeyC" || key === "c"
    if (!isCopy) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.repeat) return
    void copy()
  }
  host.addEventListener("keydown", onKey, { capture: true })
  // Image paste: Ctrl+V / context-menu paste surfaces a ClipboardEvent on the
  // focused xterm helper textarea (inside host). Text keeps flowing through
  // the shortcut + bridge path above; only image payloads are intercepted
  // here and uploaded to ~/still-uploads via the live PTY.
  const onPasteEvent = async (event: ClipboardEvent) => {
    const data = event.clipboardData
    if (!data) return
    let image: File | null = null
    const files = data.files
    if (files) {
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) { image = file; break }
      }
    }
    if (!image && data.items) {
      for (const item of Array.from(data.items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) { image = file; break }
        }
      }
    }
    if (image) {
      event.preventDefault()
      event.stopImmediatePropagation()
      void pasteImage(image)
      return
    }
    const text = data.getData("text/plain")
    if (!text) {
      // Bitmap-only clipboard: no file item and no text (common for
      // screenshots on some WebViews). Fall back to a native image read.
      event.preventDefault()
      event.stopImmediatePropagation()
      const image = await readClipboardImageFile()
      if (image) void pasteImage(image)
      else if (alive) notify("Nothing to paste. Copy an image or text first.")
      return
    }
    if (!host.contains(document.activeElement)) return
    const target = syncOwner()
    if (!target) return
    event.preventDefault()
    event.stopImmediatePropagation()
    terminal.paste(text)
  }
  host.addEventListener("paste", onPasteEvent)
  return {
    endReplay: () => { replaying = false },
    dispose: () => {
      alive = false
      remoteCopy = null
      osc.dispose()
      host.removeEventListener("keydown", onKey, { capture: true })
      host.removeEventListener("paste", onPasteEvent)
    },
  }
}
