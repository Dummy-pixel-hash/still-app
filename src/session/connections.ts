// Still M2 — connection registry.
//
// Maps STABLE local session ids -> live native session ids (`sess-…`).
// Session identity (local id + tmux name) survives disconnect; the native
// session id is transient per connection. Leaving the workspace overlay is
// NOT a disconnect: the worker keeps running until explicit Disconnect.

import { useCallback, useSyncExternalStore } from "react"
import { Terminal } from "@xterm/xterm"
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

// A headless xterm keeps the card preview in the same state as the real
// terminal. Parsing the raw stream as text cannot represent cursor-addressed
// redraws, alternate-screen TUIs, carriage returns, or clears.
const PREVIEW_COLS = 64
const PREVIEW_ROWS = 8
const PREVIEW_FROZEN_PREFIX = "still.preview.screen.v1."
const PREVIEW_FROZEN_MIN_MS = 2000
interface PreviewTerminalState {
  terminal: Terminal
  /** Total transcript bytes queued into xterm, not just bytes already parsed. */
  queuedTotal: number
  /** Total transcript bytes whose xterm write callback has fired. */
  parsedTotal: number
}
const previewTerminals = new Map<string, PreviewTerminalState>()

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

function newPreviewTerminal(): Terminal {
  return new Terminal({
    cols: PREVIEW_COLS,
    rows: PREVIEW_ROWS,
    convertEol: false,
    cursorBlink: false,
    scrollback: 0,
    allowProposedApi: false,
  })
}

function disposePreviewTerminal(localId: string) {
  const state = previewTerminals.get(localId)
  if (!state) return
  state.terminal.dispose()
  previewTerminals.delete(localId)
}

/**
 * Bring the headless preview emulator up to the current transcript. A full
 * replay is used whenever the ring changed since the emulator was built; it
 * is cheap at 64x8 and, unlike incremental bookkeeping, remains correct when
 * the byte ring evicts its oldest bytes or a session is reloaded.
 */
function syncPreviewTerminal(localId: string): PreviewTerminalState | null {
  try {
    const bytes = transcriptSnapshot(localId)
    const total = transcripts.get(localId)?.totalBytes ?? 0
    let state = previewTerminals.get(localId)
    if (bytes.length === 0 && total === 0) {
      if (state) disposePreviewTerminal(localId)
      return null
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
      state = { terminal: newPreviewTerminal(), queuedTotal: 0, parsedTotal: 0 }
      previewTerminals.set(localId, state)
      if (bytes.length > 0) {
        const writeState = state
        // Set this before write(): headless xterm may invoke its callback
        // synchronously, while a WebView may complete it asynchronously.
        state.queuedTotal = total
        state.terminal.write(bytes, () => {
          if (previewTerminals.get(localId) !== writeState) return
          writeState.parsedTotal = total
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

function previewRows(state: PreviewTerminalState, maxRows = PREVIEW_ROWS, maxCols = PREVIEW_COLS): string[] {
  // While a new write is queued, return the last parsed frame. This avoids
  // flashing back to raw text and keeps the preview stable between frames.
  const buffer = state.terminal.buffer.active
  const rows = Math.min(maxRows, state.terminal.rows, buffer.length)
  const lines: string[] = []
  for (let y = 0; y < rows; y += 1) {
    const line = buffer.getLine(y)?.translateToString(true, 0, maxCols) ?? ""
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function persistRenderedFrozenPreview(localId: string) {
  const state = previewTerminals.get(localId)
  if (!state || state.parsedTotal !== state.queuedTotal) return
  const lines = previewRows(state)
  if (lines.length === 0) return
  const now = Date.now()
  if (now - (previewFrozenLastPersist.get(localId) ?? 0) < PREVIEW_FROZEN_MIN_MS) return
  previewFrozenLastPersist.set(localId, now)
  try {
    localStorage.setItem(PREVIEW_FROZEN_PREFIX + localId, lines.join("\n"))
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
  const buf = transcripts.get(localId) ?? new ByteRing(TRANSCRIPT_CAP)
  buf.append(data)
  transcripts.set(localId, buf)

  // Keep the headless emulator in lockstep with the raw stream. Its callback
  // is the point at which the active buffer is safe to read; card listeners
  // are notified there rather than displaying a half-parsed frame.
  syncPreviewTerminal(localId)
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
  maxRows = PREVIEW_ROWS,
  maxCols = PREVIEW_COLS,
): string[] | null {
  try {
    const state = syncPreviewTerminal(localId)
    if (!state) return null
    if (state.parsedTotal !== state.queuedTotal) {
      // Keep showing the last parsed screen while a new frame is queued;
      // never fall back to raw stream text during that small window.
      requestPreviewUpdate(localId)
    }
    return previewRows(state, maxRows, maxCols)
  } catch {
    // A preview must never take down the workspace if xterm cannot initialize
    // in an unusual WebView/runtime. The stripped text path remains available.
    return null
  }
}

export function clearTranscript(localId: string) {
  transcripts.delete(localId)
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

/**
 * True when the transcript tail shows a fullscreen TUI owning the screen
 * (alt-screen enter without a matching exit). Its bytes are
 * cursor-addressed redraws, not scrollback — stripping escapes leaves
 * concatenated fragments ("@@e@", "eee"), never readable lines.
 */
export function isTuiActive(localId: string): boolean {
  const bytes = transcriptSnapshot(localId)
  if (bytes.length === 0) return false
  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.slice(Math.max(0, bytes.length - 4096)),
  )
  const enters = (text.match(/\x1b\[\?(?:1049|1047|1048)h/g) ?? []).length
  const exits = (text.match(/\x1b\[\?(?:1049|1047|1048)l/g) ?? []).length
  return enters > exits
}

/** Last non-empty lines of the live transcript tail (plain text). */
export function snapshotPreviewLines(localId: string, max = 4): string[] {
  const bytes = transcriptSnapshot(localId)
  if (bytes.length === 0) return []
  // Strip BEFORE slicing: the old slice-then-strip cut escape sequences
  // in half at the window edge, orphaning tails ("86m", "(B") that
  // rendered as garble. Stripping the full decode first keeps sequences
  // whole; the plain-text tail slice then can't split an escape.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  return stripPreviewAnsi(text)
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.length > 0)
    .slice(-max)
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

/** Frozen snapshot lines, if any (disconnect + reload safe). */
export function frozenPreview(localId: string): string[] | null {
  try {
    const rendered = localStorage.getItem(PREVIEW_FROZEN_PREFIX + localId)
    if (rendered) {
      const screenLines = rendered.split("\n")
      while (screenLines.length > 0 && screenLines[screenLines.length - 1] === "") {
        screenLines.pop()
      }
      if (screenLines.length > 0) return screenLines
    }
    const raw = localStorage.getItem(FROZEN_PREFIX + localId)
    if (!raw) return null
    const lines = raw.split("\n").filter((l) => l.length > 0)
    return lines.length > 0 ? lines : null
  } catch {
    return null
  }
}

export function discardFrozenPreview(localId: string) {
  frozenLastPersist.delete(localId)
  previewFrozenLastPersist.delete(localId)
  try {
    localStorage.removeItem(FROZEN_PREFIX + localId)
    localStorage.removeItem(PREVIEW_FROZEN_PREFIX + localId)
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
