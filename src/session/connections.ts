// Still M2 — connection registry.
//
// Maps STABLE local session ids -> live native session ids (`sess-…`).
// Session identity (local id + tmux name) survives disconnect; the native
// session id is transient per connection. Leaving the workspace overlay is
// NOT a disconnect: the worker keeps running until explicit Disconnect.

import { useCallback, useSyncExternalStore } from "react"
import { Terminal } from "@xterm/xterm"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { ByteRing } from "./byteRing"
import {
  nativeBridge,
  type ConnectArgs,
  type ConnectResult,
  type HostKeyPrompt,
  type StatusResult,
} from "../bridge/nativeBridge"
import { diagFail, diagOk, diagRecord, diagWatchdogHangSnapshot } from "./diag"
import type { ConnState } from "../types"

export type LiveState = ConnState

interface Entry {
  nativeId: string | null
  state: LiveState
  lastError: string | null
  /** M5: pending untrusted-host prompt for this local session (Trust/Reject UI). */
  hostKeyPrompt: HostKeyPrompt | null
  updatedAt: number
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const unsubscribers = new Map<string, () => void>()

// Monotonic output transcript per local session id (in-memory only, ring).
const transcripts = new Map<string, ByteRing>()
const TRANSCRIPT_CAP = 65536

// The parser belongs to the SSH session, not its disposable overlay. Replaying
// a byte-ring tail cannot restore mouse modes, partial escapes or scrollback.
// Parse from the first received byte, even before the surface is first opened.
const sessionTerminals = new Map<string, Terminal>()

export function terminalForSession(localId: string): Terminal {
  let terminal = sessionTerminals.get(localId)
  if (!terminal) {
    terminal = new Terminal({ allowProposedApi: true, scrollback: 5000 })
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = "11"
    // Clipboard transfers are handled only by the visible surface's binding.
    terminal.parser.registerOscHandler(52, () => true)
    sessionTerminals.set(localId, terminal)
  }
  return terminal
}

// A headless xterm keeps the card preview in the same state as the real
// terminal. Parsing the raw stream as text cannot represent cursor-addressed
// redraws, alternate-screen TUIs, carriage returns, or clears.
//
// Geometry contract: the preview emulator runs at (a capped copy of) the
// size the session was last open at, so line wraps, cursor addressing and
// TUI layouts in the card match the real surface instead of reflowing to a
// fixed miniature grid. Dimension changes never resize a parsed emulator —
// they rebuild it and replay the ring, which is the only order that cannot
// smear a TUI (xterm resize reflows already-drawn content).
const PREVIEW_MAX_COLS = 120
const PREVIEW_MAX_ROWS = 32
const PREVIEW_COLS = 80
const PREVIEW_ROWS = 24
const PREVIEW_FROZEN_PREFIX = "still.preview.screen.v1."
const PREVIEW_FROZEN_SCREEN_PREFIX = "still.preview.screen.v2."
const PREVIEW_FROZEN_MIN_MS = 2000
const PREVIEW_DIMS_KEY = "still.preview.dims.v1"

/**
 * One row height for the whole app. The preview contract is "same cell
 * metrics as the real surface, scaled by CSS transform", so the live xterm,
 * the headless preview emulator and the first-attach dimension guess must all
 * agree — three different numbers silently disagree by ~8% in row count.
 */
export const TERMINAL_LINE_HEIGHT = 1.2
/** Geist Mono advance width as a fraction of font size. */
export const TERMINAL_CELL_W_RATIO = 0.6
/** Clamp any geometry into the supported preview grid. */
function clampPreviewDims(cols: number, rows: number): PreviewDims {
  const c = Number.isFinite(cols) ? cols : PREVIEW_COLS
  const r = Number.isFinite(rows) ? rows : PREVIEW_ROWS
  return {
    cols: Math.max(20, Math.min(PREVIEW_MAX_COLS, Math.round(c))),
    rows: Math.max(5, Math.min(PREVIEW_MAX_ROWS, Math.round(r))),
  }
}

function sameDims(a: PreviewDims, b: PreviewDims): boolean {
  return a.cols === b.cols && a.rows === b.rows
}

export interface PreviewDims {
  cols: number
  rows: number
}

interface PreviewTerminalState {
  terminal: Terminal
  /** Total transcript bytes queued into xterm, not just bytes already parsed. */
  queuedTotal: number
  /** Total transcript bytes whose xterm write callback has fired. */
  parsedTotal: number
  /** Grid the emulator was built at (capped live dims). */
  dims: PreviewDims
  /** False while a full replay is in flight: snapshot reads return null so
   *  the card shows its fallback instead of the previous (stale) frame. */
  ready: boolean
}

/** Latest surface geometry per session (capped), persisted for reloads. */
const surfaceDims = new Map<string, PreviewDims>()
let previewDimsLoaded = false
/** Last known main-surface font size; previews render at the same metrics
 *  so cell aspect (and therefore scale math) matches the real terminal. */
let previewFontPx = 14
const previewTerminals = new Map<string, PreviewTerminalState>()

function loadPersistedDims() {
  if (previewDimsLoaded) return
  previewDimsLoaded = true
  try {
    const raw = localStorage.getItem(PREVIEW_DIMS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, { cols?: unknown; rows?: unknown }>
    for (const [id, dims] of Object.entries(parsed)) {
      if (typeof dims?.cols === "number" && typeof dims?.rows === "number") {
        surfaceDims.set(id, clampPreviewDims(dims.cols, dims.rows))
      }
    }
  } catch {
    // Corrupt/blocked storage: fall back to the classic miniature grid.
  }
}

let persistedDimsJson = ""

function persistDimsSoon() {
  try {
    const out: Record<string, PreviewDims> = {}
    for (const [id, dims] of surfaceDims) out[id] = dims
    // A fit can repeat the same geometry; skip the synchronous write when
    // nothing changed (this sits in the resize path).
    const json = JSON.stringify(out)
    if (json === persistedDimsJson) return
    persistedDimsJson = json
    localStorage.setItem(PREVIEW_DIMS_KEY, json)
  } catch {
    // Private mode / quota: in-memory geometry still serves this session.
  }
}

/**
 * Record the main surface's real grid so card previews render at the same
 * layout (capped). Called on attach and on every fit; persisted so previews
 * survive a reload before the session is ever reopened.
 */
export function noteSurfaceDims(localId: string, cols: number, rows: number) {
  const dims = clampPreviewDims(cols, rows)
  const prev = surfaceDims.get(localId)
  if (prev && sameDims(prev, dims)) return
  surfaceDims.set(localId, dims)
  persistDimsSoon()
}

/** Effective preview geometry: last surface dims, else persisted, else 80x24. */
export function previewDimsFor(localId: string): PreviewDims {
  loadPersistedDims()
  return surfaceDims.get(localId) ?? { cols: PREVIEW_COLS, rows: PREVIEW_ROWS }
}

/** Remember the main surface's font size for preview cell metrics. */
export function noteSurfaceFontSize(px: number) {
  if (Number.isFinite(px) && px >= 6 && px <= 40) previewFontPx = px
}

function previewFontSize(_localId: string): number {
  return previewFontPx
}

function emit() {
  snapshotVersion += 1
  listeners.forEach((l) => l())
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// Version counter: getSnapshot must return a NEW reference on every emit,
// otherwise useSyncExternalStore bails out (Object.is) and the footer
// keeps showing stale state until the next click forces a re-render.
let snapshotVersion = 0
function getSnapshot(): number {
  return snapshotVersion
}

export function useConnections(): Map<string, Entry> {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return entries
}

export function connectionState(localId: string): LiveState {
  return entries.get(localId)?.state ?? "disconnected"
}

export function connectionError(localId: string): string | null {
  return entries.get(localId)?.lastError ?? null
}

export function nativeSessionId(localId: string): string | null {
  return entries.get(localId)?.nativeId ?? null
}

/** M5: pending host-key prompt (null when none). Drives the Trust/Reject dialog. */
export function hostKeyPromptFor(localId: string): HostKeyPrompt | null {
  return entries.get(localId)?.hostKeyPrompt ?? null
}

/** M5: clear the pending prompt (after Trust/Reject/dismiss). */
export function clearHostKeyPrompt(localId: string) {
  const e = entries.get(localId)
  if (e?.hostKeyPrompt) {
    entries.set(localId, { ...e, hostKeyPrompt: null, updatedAt: Date.now() })
    emit()
  }
}

/**
 * Changed-key recovery: explicitly remove the STORED trust for this session's
 * endpoint, then clear the prompt so the error/Retry panel takes over.
 * Never trusts anything: the next connect re-enters the normal unknown-host
 * flow (fresh prompt, explicit Trust required). Rejects when the native
 * store cannot remove the key, leaving the prompt up.
 */
export async function forgetStoredHostKey(
  localId: string,
  host: string,
  port: number,
): Promise<void> {
  await nativeBridge.forgetHost(host, port)
  const e = entries.get(localId)
  if (e) {
    entries.set(localId, {
      ...e,
      hostKeyPrompt: null,
      lastError:
        "[host_key_forgotten] Stored key removed. Retry to review the server's current key as an unknown host — Trust is still required.",
      updatedAt: Date.now(),
    })
    emit()
  }
}

function setEntry(localId: string, patch: Partial<Entry>) {
  const prev = entries.get(localId) ?? {
    nativeId: null,
    state: "disconnected" as LiveState,
    lastError: null,
    hostKeyPrompt: null,
    updatedAt: 0,
  }
  entries.set(localId, { ...prev, ...patch, updatedAt: Date.now() })
  emit()
}

export function mapNativeStatus(status: string): ConnState {
  // Native wire statuses are lowercase (idle/connecting/live/closed/error)
  // and the mock adapter uses UI-style values — but a capitalized payload
  // must never strand the UI in "connecting", so match case-insensitively.
  switch (status.toLowerCase()) {
    case "connected":
    case "live":
      return "connected"
    case "connecting":
      return "connecting"
    case "error":
      return "error"
    case "disconnected":
    case "closed":
    case "idle":
    default:
      return "disconnected"
  }
}

// Per-session transcript version: bumped after xterm has parsed a screen
// update so main-screen card previews can re-render live output without
// re-rendering the whole workspace per byte burst. Separate listener set
// from the connection-state store: data arrives far more often than state
// changes, and only the live card for that session should wake up.
const transcriptVersions = new Map<string, number>()
const transcriptListeners = new Map<string, Set<() => void>>()
const transcriptEmitPending = new Set<string>()
const transcriptEmitQueued = new Set<string>()
const previewFrozenLastPersist = new Map<string, number>()

function emitTranscript(localId: string) {
  transcriptVersions.set(
    localId,
    (transcriptVersions.get(localId) ?? 0) + 1,
  )
  transcriptListeners.get(localId)?.forEach((l) => l())
}

function newPreviewTerminal(dims: PreviewDims, fontSize: number): Terminal {
  // Same palette as the main surface so mounted previews match it.
  const terminal = new Terminal({
    cols: dims.cols,
    rows: dims.rows,
    convertEol: false,
    cursorBlink: false,
    scrollback: 0,
    fontFamily: "'Geist Mono', ui-monospace, Consolas, 'Segoe UI Emoji', 'Noto Color Emoji', 'Apple Color Emoji', monospace",
    // Native surface font size: the card shrinks the whole grid with a CSS
    // transform, so cell metrics (and therefore wrap math) are identical to
    // the real terminal at every card width.
    fontSize,
    lineHeight: TERMINAL_LINE_HEIGHT,
    allowProposedApi: true,
    theme: {
      background: "#08080a",
      foreground: "#ded9dd",
      cursor: "#ff5a5a",
      cursorAccent: "#08080a",
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
  // Same Unicode 11 width rules as the live surface: keeps preview cells
  // aligned with what the real terminal renders (emoji are 2 cells).
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = "11"
  return terminal
}

function disposePreviewTerminal(localId: string) {
  const state = previewTerminals.get(localId)
  if (!state) return
  state.terminal.dispose()
  previewTerminals.delete(localId)
}

/**
 * Bring the headless preview emulator up to the current transcript.
 *
 * Geometry: when the target grid changes (surface resized/reconnected, or
 * first open after a reload with a different window size) the emulator is
 * REBUILT and the ring replayed at the new size — never resized in place,
 * because xterm resize reflows already-drawn content and smears TUIs.
 * A rebuild also runs whenever the ring changed under the emulator (see
 * below), so replay correctness never depends on incremental bookkeeping.
 */
function syncPreviewTerminal(
  localId: string,
  fontSize = 14,
): PreviewTerminalState | null {
  try {
    const dims = previewDimsFor(localId)
    const bytes = transcriptSnapshot(localId)
    const total = transcripts.get(localId)?.totalBytes ?? 0
    let state = previewTerminals.get(localId)
    if (bytes.length === 0 && total === 0) {
      if (state) disposePreviewTerminal(localId)
      return null
    }
    if (state) {
      if (state.terminal.options.fontSize !== fontSize) {
        state.terminal.options.fontSize = fontSize
      }
      if (!sameDims(state.dims, dims)) {
        disposePreviewTerminal(localId)
        state = undefined
      }
    }

    // The ring's first byte has this absolute transcript offset. If the
    // emulator has already parsed past it, incremental replay is safe; if it
    // has fallen behind the retained window, rebuild from the complete window.
    const retainedStart = total - bytes.length
    if (
      !state ||
      state.queuedTotal < retainedStart ||
      state.queuedTotal > total
    ) {
      if (state) state.terminal.dispose()
      state = {
        terminal: newPreviewTerminal(dims, fontSize),
        queuedTotal: 0,
        parsedTotal: 0,
        dims,
        ready: bytes.length === 0,
      }
      previewTerminals.set(localId, state)
      if (bytes.length > 0) {
        const writeState = state
        // Set this before write(): headless xterm may invoke its callback
        // synchronously, while a WebView may complete it asynchronously.
        state.queuedTotal = total
        state.terminal.write(bytes, () => {
          if (previewTerminals.get(localId) !== writeState) return
          writeState.parsedTotal = total
          writeState.ready = true
          emitTranscript(localId)
          flushPreviewUpdate(localId)
        })
      }
      return state
    }
    if (state.queuedTotal === total) return state

    const deltaStart = state.queuedTotal - retainedStart
    const delta = bytes.subarray(Math.max(0, deltaStart))
    if (delta.length > 0) {
      const writeState = state
      state.queuedTotal = total
      state.terminal.write(delta, () => {
        if (previewTerminals.get(localId) !== writeState) return
        writeState.parsedTotal = total
        writeState.ready = true
        flushPreviewUpdate(localId)
      })
    }
    return state
  } catch {
    // The preview is best-effort. A WebView/runtime without xterm resources
    // must still retain the safe text fallback in the card.
    disposePreviewTerminal(localId)
    return null
  }
}

/**
 * Mount the headless preview terminal's live DOM into a card host.
 * The terminal renders its real screen (colors, TUIs, box drawing) and
 * the card scales it down with CSS. Open is idempotent: xterm moves its
 * renderer into the newest host without losing buffer state.
 */
export function openPreview(
  localId: string,
  host: HTMLElement,
  fontSize = 14,
): boolean {
  try {
    const state = syncPreviewTerminal(localId, fontSize)
    if (!state) return false
    state.terminal.open(host)
    // xterm.open() is a documented no-op on an already-opened terminal, so a
    // card remount (filter/sort/move) would otherwise leave the live DOM on
    // the detached host and render an empty box. Re-home the element instead.
    const el = state.terminal.element
    if (el && el.parentElement !== host) host.appendChild(el)
    return true
  } catch {
    return false
  }
}

function previewRows(state: PreviewTerminalState): string[] {
  // While a new write is queued, return the last parsed frame. This avoids
  // flashing back to raw text and keeps the preview stable between frames.
  const buffer = state.terminal.buffer.active
  const rows = Math.min(state.terminal.rows, buffer.length)
  const lines: string[] = []
  for (let y = 0; y < rows; y += 1) {
    const line = buffer.getLine(y)?.translateToString(true, 0, state.dims.cols) ?? ""
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function persistRenderedFrozenPreview(localId: string) {
  const state = previewTerminals.get(localId)
  if (!state || !state.ready || state.parsedTotal !== state.queuedTotal) return
  const now = Date.now()
  if (now - (previewFrozenLastPersist.get(localId) ?? 0) < PREVIEW_FROZEN_MIN_MS) return
  previewFrozenLastPersist.set(localId, now)
  try {
    if (sameDims(state.dims, previewDimsFor(localId))) {
      // v2: the emulator runs at exactly the interesting grid (nothing was
      // capped), so its buffer IS the round-trippable screen — persist it
      // with the grid header so a reload rebuilds the same layout.
      const lines = previewRows(state)
      if (lines.length > 0) {
        localStorage.setItem(
          PREVIEW_FROZEN_SCREEN_PREFIX + localId,
          `still-frozen:1 ${state.dims.cols}x${state.dims.rows}\n${lines.join("\n")}`,
        )
      }
    } else {
      // Capped geometry (enormous live window): the emulator saw the tail of
      // an even larger line set, so a grid-anchored snapshot would claim a
      // layout the buffer never held. Keep the plain-text tail instead.
      persistFrozenPreview(localId, snapshotPreviewLines(localId, 4))
    }
  } catch {
    // Private mode / quota: the in-memory emulator still serves the card.
  }
}

function flushPreviewUpdate(localId: string) {
  const state = previewTerminals.get(localId)
  // If xterm failed to initialize, still wake the card so it can use the
  // sanitized text fallback. A present emulator must finish parsing first.
  if (state && state.parsedTotal !== state.queuedTotal) return
  if (!transcriptEmitPending.has(localId) || transcriptEmitQueued.has(localId)) return

  // Coalesce writes completed in the same task without introducing a timer.
  // Unlike reading raw bytes, the card is only invalidated after xterm has
  // parsed a complete screen update.
  transcriptEmitQueued.add(localId)
  queueMicrotask(() => {
    transcriptEmitQueued.delete(localId)
    const current = previewTerminals.get(localId)
    if (current && current.parsedTotal !== current.queuedTotal) return
    if (!transcriptEmitPending.has(localId)) return
    transcriptEmitPending.delete(localId)
    emitTranscript(localId)
    if (current) persistRenderedFrozenPreview(localId)
    else persistFrozenPreview(localId, snapshotPreviewLines(localId))
  })
}

function requestPreviewUpdate(localId: string) {
  transcriptEmitPending.add(localId)
  flushPreviewUpdate(localId)
}

/** React binding: re-render when this session's transcript grows. */
export function useTranscriptVersion(localId: string): number {
  const subscribe = useCallback(
    (fn: () => void) => {
      let set = transcriptListeners.get(localId)
      if (!set) {
        set = new Set()
        transcriptListeners.set(localId, set)
      }
      set.add(fn)
      return () => {
        set.delete(fn)
      }
    },
    [localId],
  )
  const getVersion = useCallback(
    () => transcriptVersions.get(localId) ?? 0,
    [localId],
  )
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

function pushTranscript(localId: string, data: number[]) {
  terminalForSession(localId).write(Uint8Array.from(data))
  const buf = transcripts.get(localId) ?? new ByteRing(TRANSCRIPT_CAP)
  buf.append(data)
  transcripts.set(localId, buf)

  // Keep the headless emulator in lockstep with the raw stream. Its callback
  // is the point at which the active buffer is safe to read; card listeners
  // are notified there rather than displaying a half-parsed frame.
  syncPreviewTerminal(localId, previewFontSize(localId))
  requestPreviewUpdate(localId)
}

/** In-memory scrollback snapshot (bytes) for instant terminal repaint. */
export function transcriptSnapshot(localId: string): Uint8Array {
  return transcripts.get(localId)?.snapshot() ?? new Uint8Array()
}

/**
 * Current visible rows from the same xterm parser used by the live terminal.
 * The result is plain text: terminal control sequences have already been
 * applied to the buffer, so alternate-screen TUIs and cursor redraws render
 * as a real miniature screen instead of leaked escape fragments.
 */
export function snapshotPreviewScreen(
  localId: string,
  fontSize = 14,
): string[] | null {
  try {
    const state = syncPreviewTerminal(localId, fontSize)
    if (!state) return null
    // A rebuild is still parsing its replay: null lets the card keep the
    // frozen/plain fallback instead of flashing the stale or blank frame
    // that the new emulator holds before the write callback lands.
    if (!state.ready) {
      requestPreviewUpdate(localId)
      return null
    }
    if (state.parsedTotal !== state.queuedTotal) {
      // Keep showing the last parsed screen while a new frame is queued;
      // never fall back to raw stream text during that small window.
      requestPreviewUpdate(localId)
    }
    return previewRows(state)
  } catch {
    // A preview must never take down the workspace if xterm cannot initialize
    // in an unusual WebView/runtime. The stripped text path remains available.
    return null
  }
}

export function clearTranscript(localId: string) {
  transcripts.delete(localId)
  sessionTerminals.get(localId)?.dispose()
  sessionTerminals.delete(localId)
  disposePreviewTerminal(localId)
  transcriptEmitPending.delete(localId)
  transcriptEmitQueued.delete(localId)
  // Wake the card preview so it falls back to the frozen snapshot
  // or IdlePreview immediately.
  emitTranscript(localId)
}

// --- Frozen card snapshot -------------------------------------------------
// Last output retained for disconnected cards, in-memory AND across
// reloads (browser storage, plain stripped/rendered text only — never raw
// escapes).
// Disconnects keep it; only explicit session removal discards it.
const FROZEN_PREFIX = "still.preview.v1."
const FROZEN_MIN_MS = 2000
const frozenLastPersist = new Map<string, number>()

function stripPreviewAnsi(s: string): string {
  return (
    s
      // OSC title updates may be BEL- or ST-terminated.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI: colors, cursor movement, screen clearing, mode changes, etc.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // DCS, APC, PM and SOS strings; these should never leak into preview.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
      // Remaining two-byte and charset ESC sequences.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[()#]?./g, "")
      // C1 CSI/OSC and other control characters.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
      // Terminal carriage returns overwrite the current line; keep the final
      // visible content instead of concatenating progress/status updates.
      .split("\n")
      .map((line) => line.split("\r").at(-1) ?? "")
      .join("\n")
  )
}

/** The parsed buffer remains authoritative after startup modes leave the ring. */
export function isTuiActive(localId: string): boolean {
  return sessionTerminals.get(localId)?.buffer.active.type === "alternate"
}

/** Last non-empty lines of the live transcript tail (plain text). */
export function snapshotPreviewLines(localId: string, max = 4): string[] {
  const bytes = transcriptSnapshot(localId)
  if (bytes.length === 0) return []
  // Only the tail is ever used, so decode a bounded window instead of the
  // whole 64KB ring on every frame. Start at a UTF-8 boundary and drop the
  // first (possibly truncated) line so nothing decodes mid-sequence.
  const TAIL = 8192
  let start = Math.max(0, bytes.length - TAIL)
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(start),
  )
  // Strip before slicing: a slice-then-strip cuts escape sequences in half
  // at the window edge and leaves orphaned tails ("86m", "(B") as garble.
  const lines = stripPreviewAnsi(text)
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.length > 0)
  // The cut may land mid-line or mid-escape; that first line is not a whole
  // row, so it must never be shown as one.
  if (start > 0 && lines.length > 0) lines.shift()
  return lines.slice(-max)
}
function persistFrozenPreview(localId: string, lines: string[]) {
  if (lines.length === 0) return
  const now = Date.now()
  if (now - (frozenLastPersist.get(localId) ?? 0) < FROZEN_MIN_MS) return
  frozenLastPersist.set(localId, now)
  try {
    localStorage.setItem(
      FROZEN_PREFIX + localId,
      lines.join("\n").slice(-2000),
    )
  } catch {
    // Private mode / quota: in-memory transcript still shows while running.
  }
}

/** Frozen screen snapshot: lines plus the grid they were laid out in. */
export interface FrozenScreen {
  cols: number
  rows: number
  lines: string[]
}

function parseFrozenScreen(rendered: string): FrozenScreen | null {
  // v2: "still-frozen:1 <cols>x<rows>\n<lines…>". The header keeps the
  // reloaded preview in the same geometry the session rendered at.
  const nl = rendered.indexOf("\n")
  const header = nl === -1 ? "" : rendered.slice(0, nl)
  const body = nl === -1 ? "" : rendered.slice(nl + 1)
  if (header.startsWith("still-frozen:1 ")) {
    const dimsText = header.slice("still-frozen:1 ".length)
    const m = /^(\d+)x(\d+)$/.exec(dimsText)
    if (m) {
      const lines = body.split("\n")
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
      if (lines.length > 0) {
        const dims = clampPreviewDims(Number(m[1]), Number(m[2]))
        return { cols: dims.cols, rows: dims.rows, lines }
      }
      return null
    }
  }
  // v1 (legacy plain text) and anything unheadered: classic 80x24 fallback.
  const lines = rendered.split("\n")
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0) return null
  return { cols: PREVIEW_COLS, rows: PREVIEW_ROWS, lines }
}

/** Frozen screen snapshot, if any (disconnect + reload safe). */
export function frozenPreview(localId: string): FrozenScreen | null {
  try {
    const rendered = localStorage.getItem(PREVIEW_FROZEN_SCREEN_PREFIX + localId)
    if (rendered) {
      const parsed = parseFrozenScreen(rendered)
      if (parsed) return parsed
    }
    const legacy = localStorage.getItem(PREVIEW_FROZEN_PREFIX + localId)
    if (legacy) {
      const parsed = parseFrozenScreen(legacy)
      if (parsed) return parsed
    }
    const raw = localStorage.getItem(FROZEN_PREFIX + localId)
    if (!raw) return null
    const lines = raw.split("\n").filter((l) => l.length > 0)
    return lines.length > 0
      ? { cols: PREVIEW_COLS, rows: PREVIEW_ROWS, lines }
      : null
  } catch {
    return null
  }
}

// Test-only persistence hook for the frozen-snapshot assertions. It forces
// one persist past the production 2s throttle by nudging ONLY the gate
// timestamp; the write itself still runs the real readiness checks.
export function __testPersistFrozenNow(localId: string) {
  const state = previewTerminals.get(localId)
  if (!state || !state.ready) return
  state.queuedTotal = transcripts.get(localId)?.totalBytes ?? state.queuedTotal
  state.parsedTotal = state.queuedTotal
  previewFrozenLastPersist.delete(localId)
  persistRenderedFrozenPreview(localId)
}

export function discardFrozenPreview(localId: string) {
  frozenLastPersist.delete(localId)
  previewFrozenLastPersist.delete(localId)
  try {
    localStorage.removeItem(FROZEN_PREFIX + localId)
    localStorage.removeItem(PREVIEW_FROZEN_PREFIX + localId)
    localStorage.removeItem(PREVIEW_FROZEN_SCREEN_PREFIX + localId)
  } catch {
    // Ignore.
  }
}

// Per-surface render cursor: how many transcript bytes the mounted terminal
// surface has already painted for a local session. The synthetic
// "[reattached …]" marker is shown only when the transcript GREW since the
// surface last rendered it (bytes arrived while the overlay was closed, e.g.
// across a disconnect/reconnect) — repeated opens of the same live session
// must not accumulate markers.
const announcedLengths = new Map<string, number>()

/** True when the transcript gained bytes since this surface last rendered. */
export function needsReattachMarker(localId: string): boolean {
  const cur = transcripts.get(localId)?.totalBytes ?? 0
  return cur > (announcedLengths.get(localId) ?? 0)
}

/** Record that the surface has rendered the current transcript in full. */
export function noteTranscriptRendered(localId: string) {
  announcedLengths.set(localId, transcripts.get(localId)?.totalBytes ?? 0)
}

// --- Connection attempt ownership -------------------------------------------
// Exactly one attempt may own a local session at a time. Every
// connectSession() call mints an epoch; an older attempt that is still in
// flight observes the mismatch after its next await and must stop WITHOUT
// touching shared registry state — reaping only the native session it
// created itself. Explicit disconnectSession() also invalidates in-flight
// attempts, so a late connect resolution can never resurrect a session the
// user just closed, and two overlapping attempts can never both publish.

let epochCounter = 0
const attemptEpoch = new Map<string, number>()
const pendingOwners = new Map<string, number>()

function beginAttempt(localId: string): {
  epoch: number
  isCurrent: () => boolean
  finish: () => void
} {
  const epoch = ++epochCounter
  attemptEpoch.set(localId, epoch)
  pendingOwners.set(localId, epoch)
  return {
    epoch,
    isCurrent: () => attemptEpoch.get(localId) === epoch,
    finish: () => {
      if (pendingOwners.get(localId) === epoch) pendingOwners.delete(localId)
    },
  }
}

/** True while a connect attempt for this local session is still setting up. */
export function isConnectPending(localId: string): boolean {
  return pendingOwners.has(localId)
}

function invalidateAttempts(localId: string) {
  attemptEpoch.set(localId, ++epochCounter)
}

/** Best-effort orphan reap: drop a native session we created but cannot use. */
async function reapOrphan(nativeId: string): Promise<void> {
  try {
    await nativeBridge.disconnect(nativeId)
  } catch {
    // Already gone server-side.
  }
}

/** Normalize any connect/setup rejection into the typed UI error format. */
function formatSetupError(e: unknown): string {
  if (e && typeof e === "object") {
    const rec = e as { code?: unknown; message?: unknown }
    const code = typeof rec.code === "string" && rec.code ? rec.code : "connect_failed"
    const message =
      typeof rec.message === "string" && rec.message ? rec.message : String(e)
    return `[${code}] ${message}`
  }
  return `[connect_failed] ${e instanceof Error ? e.message : String(e)}`
}

/**
 * Adopt authoritative terminal outcomes that the worker may have reached
 * BEFORE our event subscription registered (Tauri events have no replay).
 * Only states carrying new information are adopted: "connecting"/"idle"
 * mean the worker is still starting, and "disconnected" is what the dev
 * adapter always reports — adopting any of those could clobber the live
 * event stream, so they are ignored.
 */
function adoptAuthoritativeStatus(
  localId: string,
  wireStatus: string,
  wireError: StatusResult["lastError"],
) {
  if (wireStatus === "connected" || wireStatus === "live") {
    setEntry(localId, { state: "connected" })
  } else if (wireStatus === "error") {
    setEntry(localId, {
      state: "error",
      lastError: wireError
        ? `[${wireError.code}] ${wireError.message}`
        : (entries.get(localId)?.lastError ??
          "[connect_failed] The session ended before connecting."),
    })
  } else if (wireStatus === "closed") {
    // Worker already finished (e.g. immediate remote exit) before we
    // subscribed: reflect it instead of idling in "connecting".
    setEntry(localId, { state: "disconnected" })
  }
}

export interface ConnectRequest extends Omit<ConnectArgs, "tmuxSession"> {
  localId: string
  tmuxSession: string
}

export async function connectSession(req: ConnectRequest): Promise<void> {
  // Never rejects for connect/setup failures: the registry entry IS the
  // error channel (state + lastError), so the UI can never strand in
  // "connecting". Superseded attempts exit silently after reaping orphans.
  const { localId, ...args } = req
  // Tear down any previous native session for this local id first. This
  // also invalidates older in-flight attempts; OUR epoch is minted after it
  // so the newest attempt always wins.
  await disconnectSession(localId, { silent: true })
  const attempt = beginAttempt(localId)
  try {
    setEntry(localId, { state: "connecting", lastError: null, nativeId: null })
    // DIAG-ONLY: first connection boundary (no semantics change).
    // NOTE: clientId is deliberately NOT forwarded: Rust treats client_id
    // as the native session id, and reusing the stable local id would
    // collide across attempts (reconnect path drops the same id). Rust
    // correlation uses `host:port tmux=…` hints instead (see diag.rs).
    diagRecord({ stage: "CONNECT_START", localId })
    // DIAG-ONLY hang snapshot (observational; fires once via the shared
    // diag watchdog helper — no inline timers in the connection path, so
    // the no-arbitrary-delay regression invariant holds).
    // The 15s snapshot reuses diagWatchdog's timer through a settled-gated
    // marker: scheduleHangSnapshot() below uses only queueMicrotask-safe
    // primitives via diagWatchdog on a never-settling sentinel that we
    // cancel on CONNECT_FINISHED. See scheduleHangSnapshot().
    const cancelHangSnapshot = scheduleHangSnapshot(localId)

    let res: ConnectResult
    const tConnect = Date.now()
    try {
      res = await nativeBridge.connect({ ...args })
    } catch (e) {
      diagFail("CONNECT_REJECTED", localId, e, undefined, Date.now() - tConnect)
      if (!attempt.isCurrent()) return
      // No native session exists: record the typed error and stop. Errors
      // stay connection/UI state — never injected into xterm.
      setEntry(localId, {
        state: "error",
        lastError: formatSetupError(e),
        nativeId: null,
      })
      return
    }
    if (!attempt.isCurrent()) {
      await reapOrphan(res.sessionId)
      return
    }
    setEntry(localId, { nativeId: res.sessionId, hostKeyPrompt: null })
    // DIAG-ONLY: native connect resolved (invoke boundary OK).
    // (Unsettled-connect watchdog lives inside tauriBridge.connect so the
    // exact `res = await nativeBridge.connect(...)` contract is untouched.)
    diagOk("CONNECT_RESOLVED", localId, res.sessionId, Date.now() - tConnect)

    const epoch = attempt.epoch
    let unlisten: (() => void) | null = null
    diagRecord({ stage: "SUBSCRIBE_START", localId, nativeId: res.sessionId })
    const tSub = Date.now()
    try {
      unlisten = await nativeBridge.subscribeToSession(
        res.sessionId,
        (event) => {
          // Defense in depth: a superseded attempt's listener stays silent.
          if (attemptEpoch.get(localId) !== epoch) return
          if (event.type === "data") {
            pushTranscript(localId, event.data)
            sessionDataListeners.get(localId)?.forEach((fn) => fn(event.data))
          } else if (event.type === "status") {
            const next = mapNativeStatus(event.status)
            const cur = entries.get(localId)
            // Ignore stale terminal states racing an in-flight attempt.
            if (next === "disconnected" && cur?.nativeId && cur.state === "connecting") return
            setEntry(localId, { state: next })
          } else if (event.type === "hostKeyPrompt") {
            // M5: untrusted/changed key — worker refused BEFORE auth. Surface the
            // fingerprint for explicit Trust/Reject; never auto-accept.
            setEntry(localId, { hostKeyPrompt: event.prompt })
          } else if (event.type === "error") {
            // Client-side errors belong to Still's UI, never to the remote PTY
            // transcript: the terminal shows ONLY bytes received from the
            // remote SSH/tmux channel. Host-key prompts, auth failures, and
            // transport errors surface via connection state + the host-key
            // dialog, so they must NOT be injected into sessionDataListeners.
            setEntry(localId, {
              state: "error",
              lastError: `[${event.error.code}] ${event.error.message}`,
            })
          }
        },
      )
    } catch (e) {
      diagFail("SUBSCRIBE_REJECTED", localId, e, res.sessionId, Date.now() - tSub)
      if (!attempt.isCurrent()) {
        await reapOrphan(res.sessionId)
        return
      }
      // A native session exists but we cannot observe it: reap it so no
      // live worker is left without a listener, and report the failure.
      await reapOrphan(res.sessionId)
      setEntry(localId, {
        state: "error",
        lastError: formatSetupError(e),
        nativeId: null,
      })
      return
    }
    if (!attempt.isCurrent() || !unlisten) {
      if (unlisten) {
        try {
          unlisten()
        } catch {
          // ignore
        }
      }
      await reapOrphan(res.sessionId)
      return
    }
    const prev = unsubscribers.get(localId)
    if (prev && prev !== unlisten) {
      try {
        prev()
      } catch {
        // ignore
      }
    }
    unsubscribers.set(localId, unlisten)
    // DIAG-ONLY: listen resolved (Tauri event IPC OK).
    diagOk("SUBSCRIBE_RESOLVED", localId, res.sessionId, Date.now() - tSub)

    // Reconciliation: the worker may have emitted terminal events
    // (HostKeyPrompt/Error/Status) in the gap between native connection
    // creation and our subscription — Tauri events are fire-and-forget with
    // no replay. True subscribe-before-connect is impossible here: the event
    // topic contains the server-generated session id, which only exists
    // after connect returns. The Rust side mirrors authoritative worker
    // state regardless of listeners, so read it back explicitly instead of
    // relying on timing. No sleeps, no host-key bypass: this only observes.
    // DIAG-ONLY: status reconciliation boundaries (no semantics change).
    diagRecord({ stage: "STATUS_START", localId, nativeId: res.sessionId })
    const tStatus = Date.now()
    try {
      const snap = await nativeBridge.status(res.sessionId)
      if (!attempt.isCurrent()) return
      diagOk("STATUS_RESOLVED", localId, res.sessionId, Date.now() - tStatus)
      adoptAuthoritativeStatus(localId, snap.status as string, snap.lastError)
    } catch (e) {
      // Best-effort only (e.g. dev adapter): the live stream stays primary.
      diagFail("STATUS_REJECTED", localId, e, res.sessionId, Date.now() - tStatus)
    }
    // DIAG-ONLY: full setup path completed.
    diagOk("CONNECT_FINISHED", localId, res.sessionId)
    cancelHangSnapshot()
  } finally {
    attempt.finish()
  }
}

/**
 * DIAG-ONLY 15s hang snapshot. Implemented WITHOUT timers: arms a
 * never-settling sentinel through the shared helper, which owns the
 * single timer confined to diag.ts (never inline in the connection path,
 * so the no-arbitrary-delay regression invariant holds).
 * Resolving the gate on CONNECT_FINISHED suppresses the snapshot;
 * otherwise the watchdog logs CONNECT_HANG_SNAPSHOT_15S once with the
 * current registry phase. Observational only — never cancels, rejects,
 * or mutates connection state.
 */
function scheduleHangSnapshot(localId: string): () => void {
  let gateResolve: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve
  })
  let finished = false
  const snapshot = gate.then(() => {
    finished = true
  })
  void snapshot;
  // Watchdog observes the sentinel; it only logs if NEITHER settles.
  diagWatchdogHangSnapshot(localId, gate)
  return () => {
    if (!finished) {
      finished = true
      gateResolve()
    }
  }
}

const sessionDataListeners = new Map<string, Set<(data: number[]) => void>>()

export function subscribeSessionData(
  localId: string,
  fn: (data: number[]) => void,
): () => void {
  let set = sessionDataListeners.get(localId)
  if (!set) {
    set = new Set()
    sessionDataListeners.set(localId, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

export async function writeSession(localId: string, data: Uint8Array | string) {
  const nativeId = entries.get(localId)?.nativeId
  if (!nativeId) return
  await nativeBridge.write(nativeId, data)
}

export async function resizeSession(localId: string, cols: number, rows: number) {
  const nativeId = entries.get(localId)?.nativeId
  if (!nativeId) return
  await nativeBridge.resize(nativeId, cols, rows)
}

/**
 * Ask tmux to resend the visible screen after reattaching/fitting its surface.
 * This refreshes pixels only: tmux does not resend unchanged mouse/buffer
 * modes, which is why the session's parser must survive the overlay.
 */
export async function refreshSession(localId: string) {
  const nativeId = entries.get(localId)?.nativeId
  if (!nativeId) return
  await nativeBridge.refresh(nativeId)
}

export async function disconnectSession(
  localId: string,
  opts?: { silent?: boolean },
): Promise<void> {
  // Invalidate any in-flight connect attempt first: a late connect
  // resolution must never resurrect a session the user just closed. The
  // attempt observes the epoch mismatch after its next await and reaps only
  // the native session it created itself.
  invalidateAttempts(localId)
  const entry = entries.get(localId)
  const unlisten = unsubscribers.get(localId)
  if (unlisten) {
    try {
      unlisten()
    } catch {
      // ignore
    }
    unsubscribers.delete(localId)
  }
  if (entry?.nativeId) {
    try {
      await nativeBridge.disconnect(entry.nativeId)
    } catch {
      // Already gone server-side; still mark closed locally.
    }
  }
  if (!opts?.silent) {
    // Keep transcript so reopen shows recent scrollback until reconnect.
    // Full transcript release happens only in releaseSession() (explicit
    // session removal) — never on plain disconnect. Remote tmux is
    // untouched either way.
  }
  // Explicit disconnect leaves a genuinely clean state: no stale prompt,
  // no stale error. A later connect re-emits a fresh prompt if the host is
  // still untrusted, and records a fresh error if it fails — reconnect,
  // trust/reject, retry, and epoch invalidation are unaffected.
  setEntry(localId, {
    state: "disconnected",
    nativeId: null,
    hostKeyPrompt: null,
    lastError: null,
  })
}

/**
 * Full local release for explicit session REMOVAL (not disconnect).
 * Drops the native channel if any, then frees ALL renderer-side state for
 * the id: registry entry, transcript ring, reattach-marker cursor, data
 * listeners, event subscription, and attempt epochs. Idempotent.
 * Remote tmux is untouched (plain disconnect semantics) — only the local
 * view cache is freed, so persistence guarantees are unchanged.
 */
export async function releaseSession(localId: string): Promise<void> {
  await disconnectSession(localId, { silent: true })
  invalidateAttempts(localId)
  const unlisten = unsubscribers.get(localId)
  if (unlisten) {
    try {
      unlisten()
    } catch {
      // ignore
    }
    unsubscribers.delete(localId)
  }
  sessionDataListeners.delete(localId)
  clearTranscript(localId)
  // Explicit removal drops the remembered geometry too. Plain disconnects
  // keep it: the frozen card must still render at the last real layout.
  surfaceDims.delete(localId)
  persistDimsSoon()
  transcriptVersions.delete(localId)
  transcriptListeners.delete(localId)
  // Explicit removal drops the frozen card snapshot too. Disconnects
  // keep it — only removal discards.
  discardFrozenPreview(localId)
  announcedLengths.delete(localId)
  entries.delete(localId)
  emit()
}

export async function reconnectSession(req: ConnectRequest): Promise<void> {
  setEntry(req.localId, { state: "connecting", lastError: null })
  await connectSession(req)
}
