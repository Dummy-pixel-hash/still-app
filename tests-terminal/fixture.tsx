import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import { Terminal } from "@xterm/xterm"
import "../src/styles/theme.css"
import SessionTerminal from "../src/terminal/SessionTerminal"
import { mockBridge } from "../src/bridge/mockBridge"
import { tauriBridge } from "../src/bridge/tauriBridge"
import { registerNativeBridge, type NativeSessionEvent } from "../src/bridge/nativeBridge"
import { connectSession, disconnectSession, releaseSession } from "../src/session/connections"
import { writeBrowserClipboard } from "../src/bridge/browserClipboard"

let sink: ((event: NativeSessionEvent) => void) | undefined
let generation = 0
let mounts = 0
let terminal: Terminal
let readResolve: ((text: string) => void) | undefined
const h = {
  writes: [] as number[][],
  copies: [] as string[],
  resizes: [] as { cols: number; rows: number }[],
  reads: 0,
  rejectCopy: false,
  rejectPaste: false,
  deferPaste: false,
  pasteText: "pasted λ\nsecond line",
  closes: 0,
  get term() { return terminal },
  emit: async (text: string) => {
    sink?.({ type: "data", data: Array.from(new TextEncoder().encode(text)) })
    await new Promise<void>(resolve => terminal.write("", resolve))
  },
  clear: () => { h.writes.length = 0; h.copies.length = 0; h.reads = 0 },
  resolvePaste: (text: string) => { readResolve?.(text) },
  reconnect: () => connect(),
  disconnect: () => disconnectSession("fixture"),
  unmount: () => root.unmount(),
  remount: () => root.render(<React.StrictMode><Surface key={++mounts} /></React.StrictMode>),
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
Terminal.prototype.open = function (parent) { originalOpen.call(this, parent); terminal = this }
registerNativeBridge({
  ...mockBridge,
  async connect() { return { sessionId: `fixture-${++generation}`, status: "connecting" } },
  async status() { return { status: "connected", lastError: null } },
  async disconnect() {},
  async subscribeToSession(_id, cb) { sink = cb; return () => { if (sink === cb) sink = undefined } },
  async write(_id, data) { h.writes.push(Array.from(typeof data === "string" ? new TextEncoder().encode(data) : data)) },
  async resize(_id, cols, rows) { h.resizes.push({ cols, rows }) },
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
})
const connect = () => connectSession({ localId: "fixture", host: "fixture.invalid", port: 22, username: "test", authKind: "password", tmuxSession: "fixture" })
await connect()
function Surface() {
  const [prefs, setPrefs] = useState({ fontSize: 14, cursorStyle: "block" as const, scrollback: 5000 })
  return <SessionTerminal localId="fixture" prefs={prefs} onClose={() => h.closes++} onZoom={delta => setPrefs(p => ({ ...p, fontSize: delta === "reset" ? 14 : Math.max(10, Math.min(24, p.fontSize + delta)) }))} />
}
const root = createRoot(document.getElementById("root")!)
root.render(<React.StrictMode><Surface /></React.StrictMode>)
Object.assign(window, { harness: h })
window.addEventListener("pagehide", () => { void releaseSession("fixture") })
