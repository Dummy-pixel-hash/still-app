// Preview-card fixture: renders the REAL SessionCard inside the workspace's
// grid container so the miniature-screen fit can be verified end-to-end in a
// browser (geometry, transform, remount re-homing, frozen snapshot).
import React from "react"
import { createRoot } from "react-dom/client"
import { Terminal } from "@xterm/xterm"
import "../src/styles/theme.css"
import SessionCard from "../src/components/SessionCard"
import { mockBridge } from "../src/bridge/mockBridge"
import { registerNativeBridge, type NativeSessionEvent } from "../src/bridge/nativeBridge"
import {
  connectSession,
  connectionState,
  disconnectSession,
  frozenPreview,
  noteSurfaceDims,
  noteSurfaceFontSize,
  previewDimsFor,
  snapshotPreviewScreen,
  subscribeSessionData,
  useConnections,
} from "../src/session/connections"
import type { Session } from "../src/types"

let sink: ((event: NativeSessionEvent) => void) | undefined
let generation = 0
let root: ReturnType<typeof createRoot>
let remounts = 0
let fontSize = 14
let visible = true
// ?no-boot=1 skips the startup emit and skips connecting: the card then shows
// only what persisted (the frozen snapshot), exactly like a real reload.
const NO_BOOT = new URLSearchParams(location.search).has("no-boot")

registerNativeBridge({
  ...mockBridge,
  async connect() {
    return { sessionId: `card-${++generation}`, status: "connecting" }
  },
  async status() {
    return { status: "connected", lastError: null }
  },
  async disconnect() {},
  async subscribeToSession(_id, cb) {
    sink = cb
    return () => {
      if (sink === cb) sink = undefined
    }
  },
})

const session: Session = {
  id: "card-fixture",
  name: "Card Fixture",
  host: "fixture.invalid",
  port: 22,
  username: "test",
  projectId: "p1",
  workingDirectory: "~/work",
  authMethod: "password",
  remember: false,
  tmuxSession: "still-card",
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
}

// Reference surface: a second emulator fed the exact same bytes, sized to the
// grid the fixture declares as the "real" terminal. Wrapping output through
// it and through the card preview must agree (that is the whole geometry
// contract), so the spec compares their text.
let reference: Terminal | undefined
function referenceText(): string {
  if (!reference) return ""
  const lines: string[] = []
  for (let i = 0; i < reference.rows; i += 1) {
    lines.push(reference.buffer.active.getLine(i)?.translateToString(true) ?? "")
  }
  return lines.join("\n").replace(/\s+$/g, "")
}

// The fixture declares 100x20 as the "real" surface grid; the reference
// emulator is laid out identically so byte-for-byte replay must wrap the
// same in both.
const REFERENCE_COLS = 100
const REFERENCE_ROWS = 20
function initReference() {
  const host = document.createElement("div")
  host.style.cssText = "position:absolute;left:-4000px;top:0;width:900px;height:400px"
  document.body.appendChild(host)
  reference = new Terminal({
    cols: REFERENCE_COLS,
    rows: REFERENCE_ROWS,
    fontSize: 14,
    lineHeight: 1.1,
    scrollback: 0,
    convertEol: false,
  })
  reference.open(host)
  subscribeSessionData(session.id, (data) => {
    reference?.write(Uint8Array.from(data))
  })
  noteSurfaceFontSize(14)
  noteSurfaceDims(session.id, REFERENCE_COLS, REFERENCE_ROWS)
}

const h = {
  emit: (text: string) =>
    sink?.({ type: "data", data: Array.from(new TextEncoder().encode(text)) }),
  disconnect: () => disconnectSession(session.id),
  connect: () => connectSession({
    localId: session.id,
    host: session.host,
    port: session.port,
    username: session.username,
    authKind: "password",
    tmuxSession: session.tmuxSession,
  }),
  status: (status: "disconnected" | "error") => sink?.({ type: "status", status }),
  dims: () => previewDimsFor(session.id),
  surface: (cols: number, rows: number) => noteSurfaceDims(session.id, cols, rows),
  font: (px: number) => {
    fontSize = px
    noteSurfaceFontSize(px)
    renderFixture()
  },
  /** Parsed frozen snapshot (same reader the card uses after a reload). */
  frozen: () => frozenPreview(session.id),
  stats: () => {
    const host = document.querySelector<HTMLElement>("[data-preview-host] .card-term")
    const screen = host?.querySelector<HTMLElement>(".xterm-screen, [data-frozen-screen]")
    const rows = host?.querySelector<HTMLElement>(".xterm-rows")
    const hostRect = host?.getBoundingClientRect()
    const screenRect = screen?.getBoundingClientRect()
    return {
      hasHost: !!host,
      hasScreen: !!screen,
      transform: screen?.style.transform ?? null,
      screenW: screen?.offsetWidth ?? 0,
      screenH: screen?.offsetHeight ?? 0,
      hostW: host?.clientWidth ?? 0,
      hostH: host?.clientHeight ?? 0,
      withinHost: !!hostRect && !!screenRect &&
        screenRect.left >= hostRect.left - 1 && screenRect.top >= hostRect.top - 1 &&
        screenRect.right <= hostRect.right + 1 && screenRect.bottom <= hostRect.bottom + 1,
      cardText: rows?.textContent ?? screen?.textContent ?? "",
      snapshotText: (snapshotPreviewScreen(session.id, fontSize) ?? []).join("\n"),
      referenceText: referenceText(),
      cols: previewDimsFor(session.id).cols,
      rows: previewDimsFor(session.id).rows,
    }
  },
  remount: () => {
    remounts += 1
    renderFixture()
  },
  show: (show: boolean) => {
    visible = show
    renderFixture()
  },
  layout: (columns: number, width: number) => {
    document.querySelector<HTMLElement>("[data-card-grid]")!.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
    document.querySelector<HTMLElement>("[data-fixture]")!.style.width = `${width}px`
  },
}

function Fixture() {
  useConnections()
  return (
    <div data-fixture style={{ width: 340, padding: 8 }}>
      <div data-card-grid style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
        {visible ? <div data-preview-host>
          <SessionCard
            session={session}
            conn={connectionState(session.id)}
            index={0}
            fontSize={fontSize}
            dragging={false}
            dropHighlight={false}
            menuOpen={false}
            onOpen={() => {}}
            onEdit={() => {}}
            onRemove={() => {}}
            onToggleMenu={() => {}}
            onCardPointerDown={() => {}}
          />
        </div> : null}
        {[1, 2].map((i) => (
          <SessionCard
            key={i}
            session={{ ...session, id: `idle-${i}`, name: `Idle ${i}` }}
            conn="never"
            index={0}
            fontSize={fontSize}
            dragging={false}
            dropHighlight={false}
            menuOpen={false}
            onOpen={() => {}}
            onEdit={() => {}}
            onRemove={() => {}}
            onToggleMenu={() => {}}
            onCardPointerDown={() => {}}
          />
        ))}
      </div>
    </div>
  )
}

function renderFixture() {
  root.render(<Fixture key={remounts} />)
}

root = createRoot(document.getElementById("root")!)
initReference()
renderFixture()
Object.assign(window, { harness: h })
if (!NO_BOOT) void h.connect().then(() => h.emit("boot\r\n"))
