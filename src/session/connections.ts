// Still M2 — connection registry.
//
// Maps STABLE local session ids -> live native session ids (`sess-…`).
// Session identity (local id + tmux name) survives disconnect; the native
// session id is transient per connection. Leaving the workspace overlay is
// NOT a disconnect: the worker keeps running until explicit Disconnect.

import { useSyncExternalStore } from "react"
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
const transcripts = new Map<string, number[]>()
const TRANSCRIPT_CAP = 65536

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

function pushTranscript(localId: string, data: number[]) {
  const buf = transcripts.get(localId) ?? []
  buf.push(...data)
  if (buf.length > TRANSCRIPT_CAP) buf.splice(0, buf.length - TRANSCRIPT_CAP)
  transcripts.set(localId, buf)
}

/** In-memory scrollback snapshot (bytes) for instant terminal repaint. */
export function transcriptSnapshot(localId: string): Uint8Array {
  return new Uint8Array(transcripts.get(localId) ?? [])
}

export function clearTranscript(localId: string) {
  transcripts.delete(localId)
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
  const cur = transcripts.get(localId)?.length ?? 0
  return cur > (announcedLengths.get(localId) ?? 0)
}

/** Record that the surface has rendered the current transcript in full. */
export function noteTranscriptRendered(localId: string) {
  announcedLengths.set(localId, transcripts.get(localId)?.length ?? 0)
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
  announcedLengths.delete(localId)
  entries.delete(localId)
  emit()
}

export async function reconnectSession(req: ConnectRequest): Promise<void> {
  setEntry(req.localId, { state: "connecting", lastError: null })
  await connectSession(req)
}
