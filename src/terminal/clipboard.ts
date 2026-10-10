import type { Terminal } from "@xterm/xterm"
import type { NativeBridge } from "../bridge/nativeBridge"

export const MAX_REMOTE_COPY_BYTES = 1024 * 1024

/** Max clipboard image accepted for remote upload (5 MiB raw). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Remote directory receiving pasted images (created on demand). */
export const IMAGE_UPLOAD_DIR = "$HOME/still-uploads"

/** Base64 payload chars per printf line (heredoc-free, shell-agnostic). */
const B64_CHUNK = 4096

/** Max bytes per still_write IPC chunk (avoids one giant JSON payload). */
export const WRITE_CHUNK_BYTES = 32 * 1024

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

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
 * host without SFTP and without heredocs.
 *
 * Why no heredoc: the old `<<'EOF'` form hung whenever the remote had
 * bracketed-paste enabled (xterm wraps the paste in ESC[200~…ESC[201~, so
 * the EOF line never matched) and it failed on macOS (`base64 -d` vs `-D`)
 * and on fish (no `<<` heredocs). This form uses one `printf '%s'` append
 * per chunk (base64 alphabet needs no quoting) plus a single `sh -c`
 * decode line, so it works from bash/zsh/fish alike. Sent via direct
 * session write (not terminal.paste), so no bracketed markers are added.
 */
export function buildImageUploadScript(remotePath: string, base64: string): string {
  const quoted = `"${remotePath.replace(/"/g, '\\"')}"`
  const b64Path = `"${remotePath.replace(/"/g, '\\"')}.b64"`
  const lines: string[] = []
  lines.push(`mkdir -p "${IMAGE_UPLOAD_DIR}" && rm -f ${b64Path}`)
  const clean = base64.replace(/\s+/g, "")
  for (let i = 0; i < clean.length; i += B64_CHUNK) {
    lines.push(`printf '%s' '${clean.slice(i, i + B64_CHUNK)}' >> ${b64Path}`)
  }
  const decode =
    `base64 -d ${b64Path} > ${quoted} 2>/dev/null || ` +
    `base64 -D ${b64Path} > ${quoted} 2>/dev/null || ` +
    `openssl base64 -d -in ${b64Path} -out ${quoted}`
  lines.push(`sh -c ${shSingleQuote(`${decode} && rm -f ${b64Path} && ls -l ${quoted}`)}`)
  return lines.join("\n")
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

/**
 * Floating thumbnail so a paste is visibly acknowledged even when the
 * remote `ls -l` output lands somewhere the user can't see it (e.g. a
 * fullscreen TUI owns the screen). Self-contained: appends an <img> to
 * the terminal host, removes it after a few seconds or on click.
 * Returns a cleanup function.
 */
function showImagePreview(host: HTMLElement, blob: Blob, caption: string): () => void {
  const url = URL.createObjectURL(blob)
  const box = document.createElement("div")
  box.setAttribute("role", "status")
  box.setAttribute("aria-label", caption)
  box.style.cssText = [
    "position:absolute", "top:12px", "right:12px", "z-index:30",
    "max-width:220px", "border-radius:10px", "overflow:hidden",
    "background:rgba(18,18,20,0.92)", "border:1px solid rgba(255,255,255,0.14)",
    "box-shadow:0 12px 32px rgba(0,0,0,0.6)", "cursor:pointer",
  ].join(";")
  const img = document.createElement("img")
  img.src = url
  img.alt = caption
  img.style.cssText = "display:block;max-width:220px;max-height:160px;object-fit:contain;background:#000"
  const label = document.createElement("div")
  label.textContent = caption
  label.style.cssText = "padding:6px 10px;font:11px ui-monospace,monospace;color:#ded9dd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
  box.appendChild(img)
  box.appendChild(label)
  host.appendChild(box)
  let gone = false
  const cleanup = () => {
    if (gone) return
    gone = true
    window.clearTimeout(timer)
    box.remove()
    URL.revokeObjectURL(url)
  }
  const timer = window.setTimeout(cleanup, 9000)
  box.addEventListener("click", cleanup)
  return cleanup
}

/** True when a fullscreen app (agent TUI, vim, tmux copy-mode…) owns the screen. */
function isAlternateScreen(terminal: Terminal): boolean {
  try {
    return terminal.buffer.active.type === "alternate"
  } catch {
    return false
  }
}

/** Local copy and explicit, bounded TUI clipboard transfers share one shortcut. */
export function bindTerminalClipboard({ terminal, host, bridge, sessionId, notify, write }: {
  terminal: Terminal
  host: HTMLElement
  bridge: () => NativeBridge
  sessionId: () => string | null
  notify: (message: string) => void
  /** Direct session write (bypasses xterm paste/bracketed markers). */
  write?: (bytes: Uint8Array) => Promise<void>
}) {
  let alive = true
  let replaying = true
  let copying = false
  let pasting = false
  let owner = sessionId()
  let remoteCopy: { text: string; time: number } | null = null
  let clearPreview: (() => void) | null = null
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
      // Always show the image locally first: the remote `ls -l` output is
      // invisible when a fullscreen app owns the screen, and the user must
      // SEE that the paste landed.
      if (alive) {
        clearPreview?.()
        clearPreview = showImagePreview(host, blob, `Image • ${formatBytes(blob.size)}`)
      }
      // A pending read must not paste into a new session.
      if (!alive || targetSession !== syncOwner()) {
        if (alive) notify("Session changed — image paste cancelled.")
        return
      }
      // Never type a shell script into a fullscreen TUI (agent UI, editor,
      // pager…): those keystrokes land in the app, not a shell — no file is
      // created and the TUI input gets trashed. Upload only at a shell prompt.
      if (isAlternateScreen(terminal)) {
        if (alive) {
          notify("Fullscreen app is active — image kept in preview. Exit to a shell prompt and paste again to upload to ~/still-uploads.")
        }
        return
      }
      // Direct write, NOT terminal.paste: xterm would wrap the payload in
      // bracketed-paste markers (ESC[200~…ESC[201~) whenever the remote
      // enables mode 2004, corrupting the upload. Chunked to avoid one
      // giant IPC payload. No focus gate: focus may move during the async
      // read, and focus is irrelevant to a direct write.
      const script = `${buildImageUploadScript(remotePath, base64)}\n`
      const bytes = new TextEncoder().encode(script)
      const send = write ?? (async (chunk: Uint8Array) => {
        terminal.paste(new TextDecoder().decode(chunk))
      })
      for (let i = 0; i < bytes.length; i += WRITE_CHUNK_BYTES) {
        await send(bytes.slice(i, i + WRITE_CHUNK_BYTES))
      }
      if (alive) notify(`Pasted image → ${remotePath} (${formatBytes(blob.size)})`)
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
      const { readClipboardImageFile } = await import("../bridge/nativeBridge")
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
      clearPreview?.()
      clearPreview = null
      osc.dispose()
      host.removeEventListener("keydown", onKey, { capture: true })
      host.removeEventListener("paste", onPasteEvent)
    },
  }
}
