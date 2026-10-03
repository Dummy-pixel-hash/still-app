// Still M2 — connection registry.
//
// Maps STABLE local session ids -> live native session ids (`sess-…`).
// Session identity (local id + tmux name) survives disconnect; the native
// session id is transient per connection. Leaving the workspace overlay is
// NOT a disconnect: the worker keeps running until explicit Disconnect.

import { useSyncExternalStore } from "react"
import { nativeBridge, type ConnectArgs, type HostKeyPrompt } from "../bridge/nativeBridge"
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
  listeners.forEach((l) => l())
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): Map<string, Entry> {
  return entries
}

export function useConnections(): Map<string, Entry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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

function mapNativeStatus(
  status: string,
): ConnState {
  // Native wire statuses are lowercase (idle/connecting/live/closed/error);
  // the bridge also forwards UI-style values from the mock adapter.
  switch (status) {
    case "connected":
    case "live":
      return "connected"
    case "connecting":
    case "reconnecting":
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

export interface ConnectRequest extends Omit<ConnectArgs, "tmuxSession"> {
  localId: string
  tmuxSession: string
}

export async function connectSession(req: ConnectRequest): Promise<void> {
  const { localId, ...args } = req
  // Tear down any previous native session for this local id first.
  await disconnectSession(localId, { silent: true })
  setEntry(localId, { state: "connecting", lastError: null, nativeId: null })

  const res = await nativeBridge.connect({ ...args })
  setEntry(localId, { nativeId: res.sessionId, hostKeyPrompt: null })

  const unlisten = await nativeBridge.subscribeToSession(
    res.sessionId,
    (event) => {
      if (event.type === "data") {
        pushTranscript(localId, event.data)
        sessionDataListeners.get(localId)?.forEach((fn) => fn(event.data))
      } else if (event.type === "status") {
        setEntry(localId, { state: mapNativeStatus(event.status) })
      } else if (event.type === "hostKeyPrompt") {
        // M5: untrusted/changed key — worker refused BEFORE auth. Surface the
        // fingerprint for explicit Trust/Reject; never auto-accept.
        setEntry(localId, { hostKeyPrompt: event.prompt })
      } else if (event.type === "error") {
        setEntry(localId, {
          state: "error",
          lastError: `[${event.error.code}] ${event.error.message}`,
        })
        sessionDataListeners
          .get(localId)
          ?.forEach((fn) =>
            fn(Array.from(new TextEncoder().encode(`\r\n[${event.error.code}] ${event.error.message}\r\n`))),
          )
      }
    },
  )
  unsubscribers.set(localId, unlisten)
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
  }
  setEntry(localId, { state: "disconnected", nativeId: null })
}

export async function reconnectSession(req: ConnectRequest): Promise<void> {
  setEntry(req.localId, { state: "connecting", lastError: null })
  await connectSession(req)
}
