import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import { Terminal } from "@xterm/xterm"
import "../src/styles/theme.css"
import SessionTerminal from "../src/terminal/SessionTerminal"
import Workspace from "../src/screens/Workspace"
import { mockBridge } from "../src/bridge/mockBridge"
import { tauriBridge } from "../src/bridge/tauriBridge"
import { registerNativeBridge, type NativeSessionEvent } from "../src/bridge/nativeBridge"
import { connectSession, disconnectSession, releaseSession, transcriptSnapshot, isTuiActive, terminalForSession } from "../src/session/connections"
import { writeBrowserClipboard } from "../src/bridge/browserClipboard"
import type { Session } from "../src/types"

const sinks = new Map<string, (event: NativeSessionEvent) => void>()
const sessions: Session[] = ["A", "B"].map(name => ({
  id: `terminal-${name.toLowerCase()}`, name: `Terminal ${name}`, host: "fixture.invalid", port: 22, username: "test",
  projectId: "fixture", workingDirectory: "~", authMethod: "ask", remember: false,
  tmuxSession: `terminal-${name.toLowerCase()}`, createdAt: 1, updatedAt: 1,
}))
const terminals = new Map<string, Terminal>()
const workspace = new URLSearchParams(location.search).has("workspace")
let generation = 0
let mounts = 0
let terminal: Terminal
let readResolve: ((text: string) => void) | undefined
const h = {
  writes: [] as number[][],
  copies: [] as string[],
  emits: [] as string[],
  resizes: [] as { cols: number; rows: number }[],
  refreshes: 0,
  writesBySession: [] as { id: string; bytes: number[] }[],
  reads: 0,
  rejectCopy: false,
  rejectPaste: false,
  deferPaste: false,
  pasteText: "pasted λ\nsecond line",
  closes: 0,
  uploads: [] as { sessionId: string; fileName: string; base64Len: number }[],
  rejectUpload: false,
  failSftp: false,
  get term() { return terminal },
  emit: async (text: string) => {
    h.receive(text)
    await new Promise<void>(resolve => terminal.write("", resolve))
  },
  clear: () => { h.writes.length = 0; h.resizes.length = 0; h.emits.length = 0; h.refreshes = 0; h.writesBySession.length = 0 },
  resolvePaste: (text: string) => { readResolve?.(text) },
  reconnect: () => connect(),
  disconnect: () => disconnectSession("fixture"),
  release: () => releaseSession("fixture"),
  hide: () => root.render(null),
  unmount: () => root.unmount(),
  remount: () => root.render(<React.StrictMode><Surface key={++mounts} /></React.StrictMode>),
  setPaused: (_paused: boolean) => {},
  receive: (text: string) => sinks.get(`fixture-${generation}`)?.({ type: "data", data: Array.from(new TextEncoder().encode(text)) }),
  output: async (id: string, text: string) => {
    sinks.get(id)?.({ type: "data", data: Array.from(new TextEncoder().encode(text)) })
    await new Promise<void>(resolve => terminalForSession(id).write("", resolve))
  },
  terminal: (id: string) => terminals.get(`still-term-${id}`),
  snapshot: () => new TextDecoder().decode(transcriptSnapshot("fixture")),
  tuiActive: () => isTuiActive("fixture"),
  baselineWheel: async () => {
    const host = document.createElement("div")
    host.style.cssText = "position:absolute;left:-2000px;width:800px;height:400px"
    document.body.appendChild(host)
    const plain = new Terminal({ fontSize: 14 })
    originalOpen.call(plain, host)
    await new Promise<void>(resolve => plain.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h", resolve))
    const data: string[] = []
    plain.onData(text => data.push(text))
    const rect = plain.element!.querySelector(".xterm-screen")!.getBoundingClientRect()
    plain.element!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: rect.height / plain.rows * 6, deltaMode: 0, clientX: rect.x + 20, clientY: rect.y + 20 }))
    plain.dispose(); host.remove()
    return data.length
  },
  browserCopy: writeBrowserClipboard,
  tauriBridge,
}
// Test-only instrumentation: production components expose no debug globals.
const originalOpen = Terminal.prototype.open
Terminal.prototype.open = function (parent) {
  originalOpen.call(this, parent)
  if (parent.id.startsWith("still-term-")) { terminal = this; terminals.set(parent.id, this) }
}
registerNativeBridge({
  ...mockBridge,
  async connect(args) { return { sessionId: workspace ? args.tmuxSession : `fixture-${++generation}`, status: "connecting" } },
  async status() { return { status: "connected", lastError: null } },
  async disconnect() {},
  async subscribeToSession(id, cb) { sinks.set(id, cb); return () => { if (sinks.get(id) === cb) sinks.delete(id) } },
  async write(id, data) {
    const bytes = Array.from(typeof data === "string" ? new TextEncoder().encode(data) : data)
    h.writes.push(bytes)
    h.writesBySession.push({ id, bytes })
  },
  async resize(_id, cols, rows) { h.resizes.push({ cols, rows }) },
  async refresh() { h.refreshes++ },
  async clipboardWriteText(text) {
    if (h.rejectCopy) throw new Error("denied")
    h.copies.push(text)
  },
  async clipboardReadText() {
    h.reads++
    if (h.rejectPaste) throw new Error("denied")
    if (h.deferPaste) return new Promise<string>(resolve => { readResolve = resolve })
    return h.pasteText
  },
  async uploadImage(sessionId: string, fileName: string, base64Data: string) {
    if (h.rejectUpload) throw new Error("denied")
    if (h.failSftp) throw new Error("sftp_unavailable: sftp disabled")
    h.uploads.push({ sessionId, fileName, base64Len: base64Data.length })
    const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_") || "still-paste.png"
    return { remotePath: `$HOME/still-uploads/${safe}` }
  },
})
const connect = () => connectSession({ localId: "fixture", host: "fixture.invalid", port: 22, username: "test", authKind: "password", tmuxSession: "fixture" })
// Geometry assertions need the same font on first fit and after zoom. A late
// fallback→webfont swap changes glyph height independently of the font size.
await document.fonts.load('14px "Geist Mono"')
if (workspace) {
  localStorage.setItem("still.m2.store.v1", JSON.stringify({ projects: [{ id: "fixture", name: "Terminals", note: "", order: 0 }], sessions, order: { fixture: sessions.map(s => s.id) }, keys: [], settings: { confirmRemove: true, terminal: { fontSize: 14, cursorStyle: "block", scrollback: 5000 } } }))
  await Promise.all(sessions.map(s => connectSession({ localId: s.id, tmuxSession: s.tmuxSession, host: s.host, port: s.port, username: s.username, authKind: "password" })))
} else await connect()
function Surface() {
  const [prefs, setPrefs] = useState({ fontSize: 14, cursorStyle: "block" as const, scrollback: 5000 })
  const [paused, setPaused] = useState(false)
  h.setPaused = setPaused
  return <SessionTerminal localId="fixture" prefs={prefs} imageInsertStyle="path" paused={paused} onClose={() => h.closes++} onZoom={delta => setPrefs(p => ({ ...p, fontSize: delta === "reset" ? 14 : Math.max(10, Math.min(24, p.fontSize + delta)) }))} />
}
const root = createRoot(document.getElementById("root")!)
root.render(<React.StrictMode>{workspace ? <Workspace /> : <Surface />}</React.StrictMode>)
Object.assign(window, { harness: h })
window.addEventListener("pagehide", () => { for (const id of workspace ? sessions.map(s => s.id) : ["fixture"]) void releaseSession(id) })
