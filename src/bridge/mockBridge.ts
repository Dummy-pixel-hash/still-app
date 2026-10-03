import type { NativeBridge, NativeSessionEvent } from "./nativeBridge"
import type { ConnectionStatus } from "../types"

const sessionSubscribers = new Map<
  string,
  Set<(event: NativeSessionEvent) => void>
>()

function emit(id: string, event: NativeSessionEvent) {
  sessionSubscribers.get(id)?.forEach((callback) => callback(event))
}

function mapRemoteStatus(status: string): ConnectionStatus {
  switch (status) {
    case "live":
      return "connected"
    case "connecting":
      return "connecting"
    case "closed":
      return "disconnected"
    case "error":
      return "error"
    default:
      return "disconnected"
  }
}

/**
 * DEVELOPMENT-ONLY renderer adapter.
 *
 * Used when the app runs as a plain web page (no Tauri runtime), e.g. `vite dev`.
 * It never opens a socket, never contacts a host, never stores credentials,
 * and never claims a real SSH connection or an active tmux session.
 * All output is explicitly labelled as a local UI simulation.
 */
export const mockBridge: NativeBridge = {
  adapterName: "Local UI simulation (development-only)",
  isDevelopmentAdapter: true,

  async ping() {
    return {
      status: "ok (renderer simulation — no native runtime)",
      app: "still-app",
      version: "0.1.0",
    }
  },

  async connect(args) {
    const sessionId = `mock-${Date.now()}`
    window.setTimeout(() => {
      emit(sessionId, { type: "status", status: "connecting" })
      window.setTimeout(() => {
        emit(sessionId, { type: "status", status: "connected" })
        const banner =
          `\r\n\x1b[2mStill renderer preview · no network connection · no tmux\x1b[0m` +
          `\r\n\x1b[31m${args.username}\x1b[0m@mock ${args.host}:${args.port}\r\n$ `
        emit(sessionId, {
          type: "data",
          data: Array.from(new TextEncoder().encode(banner)),
        })
      }, 300)
    }, 50)
    return { sessionId, status: "connecting" }
  },

  async write(sessionId, data) {
    // No-op when nothing is subscribed: mirrors the native worker, which
    // drops input for unknown/closed sessions instead of echoing anywhere.
    if (!sessionSubscribers.has(sessionId)) return
    const text = typeof data === "string" ? data : new TextDecoder().decode(data)
    // Minimal PTY line-discipline emulation: DEL erases (real backends never
    // echo a raw 0x7f), everything else echoes verbatim.
    const echoed = text.replace(/\x7f/g, "\b \b")
    window.setTimeout(() => {
      emit(sessionId, {
        type: "data",
        data: Array.from(new TextEncoder().encode(echoed)),
      })
    }, 10)
  },

  async resize() {
    return undefined
  },

  async disconnect(sessionId) {
    window.setTimeout(() => {
      // Notify while the subscriber still exists (the production worker's
      // terminal outcomes are likewise observable via status()), then drop
      // the channel: after disconnect stale input must not echo into a
      // future subscriber of the same id.
      emit(sessionId, { type: "status", status: "disconnected" })
      sessionSubscribers.delete(sessionId)
    }, 10)
  },

  async status() {
    return { status: "disconnected", lastError: null }
  },

  async subscribeToSession(sessionId, callback) {
    const listeners = sessionSubscribers.get(sessionId) ?? new Set()
    listeners.add(callback)
    sessionSubscribers.set(sessionId, listeners)
    return () => {
      listeners.delete(callback)
    }
  },

  async hasCredential() {
    return false
  },

  async forgetCredential() {
    return undefined
  },

  // M5: dev-only stub. The mock never contacts a host; probing rejects loudly
  // so no test or preview can mistake it for verified SSH.
  async probeHost() {
    throw new Error("Host-key probing is unavailable in the renderer simulation (no native runtime).")
  },
  async trustHost() {
    throw new Error("Host-key trust is unavailable in the renderer simulation (no native runtime).")
  },
  async forgetHost() {
    return undefined
  },

  // Mock keychain: in-memory only, cleared on reload. Explicitly NOT secure
  // storage — dev/testing stand-in so the key UI works in the browser.
  async saveKeySecret() {
    return undefined
  },
  async hasKeySecret() {
    return false
  },
  async forgetKeySecret() {
    return undefined
  },

  async windowMinimize() {
    return undefined
  },
  async windowToggleMaximize() {
    return undefined
  },
  async windowClose() {
    return undefined
  },
  async windowStartDrag() {
    return undefined
  },
}

export { mapRemoteStatus }
