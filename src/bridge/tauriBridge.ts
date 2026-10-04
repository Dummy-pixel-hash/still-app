import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { diagRecord, diagWatchdog } from "../session/diag"
import type {
  ConnectArgs,
  ConnectResult,
  NativeBridge,
  NativeSessionEvent,
  StatusResult,
} from "./nativeBridge"

const textEncoder = new TextEncoder()

/**
 * Production adapter: forwards calls over Tauri IPC to the Rust SSH/tmux
 * engine, and routes `still://session-event/<id>` events back to subscribers.
 * Secrets are passed per-call only and never stored in the renderer.
 */
export const tauriBridge: NativeBridge = {
  adapterName: "Tauri native bridge",
  isDevelopmentAdapter: false,

  async ping() {
    // DIAG-ONLY: startup IPC health check ("can the packaged WebView
    // invoke ANY Tauri command?"). Never gates connecting.
    const t0 = Date.now()
    diagRecord({ stage: "PING_START", localId: "" })
    const p = invoke<{ status: string; app: string; version: string }>(
      "still_ping",
    )
    diagWatchdog("PING", "", p)
    try {
      const res = await p
      diagRecord({
        stage: "PING_RESOLVED",
        localId: "",
        elapsedMs: Date.now() - t0,
      })
      return res
    } catch (e) {
      diagRecord({
        stage: "PING_REJECTED",
        localId: "",
        ok: false,
        code: "rejected",
        message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        elapsedMs: Date.now() - t0,
      })
      throw e
    }
  },

  async connect(args: ConnectArgs): Promise<ConnectResult> {
    // DIAG-ONLY: trace invoke entry/exit + watchdog for unsettled invoke.
    // Semantics unchanged: single invoke, same return/throw.
    const t0 = Date.now()
    diagRecord({ stage: "INVOKE_CONNECT_START", localId: "" })
    const p = invoke<ConnectResult>("still_connect", { args })
    diagWatchdog("CONNECT", "", p)
    try {
      const res = await p
      diagRecord({
        stage: "INVOKE_CONNECT_RESOLVED",
        localId: "",
        nativeId: res.sessionId,
        elapsedMs: Date.now() - t0,
      })
      return res
    } catch (e) {
      diagRecord({
        stage: "INVOKE_CONNECT_REJECTED",
        localId: "",
        ok: false,
        code: "rejected",
        message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        elapsedMs: Date.now() - t0,
      })
      throw e
    }
  },

  async write(sessionId: string, data: string | Uint8Array): Promise<void> {
    const bytes =
      typeof data === "string"
        ? Array.from(textEncoder.encode(data))
        : Array.from(data)
    await invoke("still_write", { args: { sessionId, data: bytes } })
  },

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await invoke("still_resize", { args: { sessionId, cols, rows } })
  },

  async disconnect(sessionId: string): Promise<void> {
    await invoke("still_disconnect", { args: { sessionId } })
  },

  async status(sessionId: string): Promise<StatusResult> {
    // DIAG-ONLY: trace invoke entry/exit + watchdog. Semantics unchanged.
    const t0 = Date.now()
    diagRecord({ stage: "INVOKE_STATUS_START", localId: "", nativeId: sessionId })
    const p = invoke<StatusResult>("still_status", { args: { sessionId } })
    diagWatchdog("STATUS", "", p)
    try {
      const res = await p
      diagRecord({
        stage: "INVOKE_STATUS_RESOLVED",
        localId: "",
        nativeId: sessionId,
        elapsedMs: Date.now() - t0,
      })
      return res
    } catch (e) {
      diagRecord({
        stage: "INVOKE_STATUS_REJECTED",
        localId: "",
        nativeId: sessionId,
        ok: false,
        code: "rejected",
        message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        elapsedMs: Date.now() - t0,
      })
      throw e
    }
  },

  async subscribeToSession(sessionId, callback) {
    // DIAG-ONLY: trace listen start/resolve + every received SessionEvent
    // type so we can tell "Rust never emitted" from "WebView never got it".
    const t0 = Date.now()
    diagRecord({ stage: "SUBSCRIBE_START", localId: "", nativeId: sessionId })
    let unlisten: () => void
    try {
      const p = listen<NativeSessionEvent>(
        `still://session-event/${sessionId}`,
        (event) => {
          // Count + type only; data payloads (byte counts) stay Rust-side.
          diagRecord({
            stage: `EVENT_RECEIVED_${event.payload?.type ?? "unknown"}`,
            localId: "",
            nativeId: sessionId,
          })
          callback(event.payload)
        },
      )
      diagWatchdog("SUBSCRIBE", "", p)
      unlisten = await p
    } catch (e) {
      diagRecord({
        stage: "SUBSCRIBE_REJECTED",
        localId: "",
        nativeId: sessionId,
        ok: false,
        code: "rejected",
        message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      })
      throw e
    }
    diagRecord({
      stage: "SUBSCRIBE_RESOLVED",
      localId: "",
      nativeId: sessionId,
      elapsedMs: Date.now() - t0,
    })
    return () => {
      diagRecord({ stage: "LISTENER_CLEANUP", localId: "", nativeId: sessionId })
      unlisten()
    }
  },

  async probeHost(host: string, port: number) {
    return invoke<import("./nativeBridge").HostKeyInfo>("still_probe_host", {
      args: { host, port },
    })
  },

  async trustHost(host: string, port: number, expectedOpenssh: string) {
    return invoke<import("./nativeBridge").HostKeyInfo>("still_trust_host", {
      args: { host, port, expectedOpenssh },
    })
  },

  async forgetHost(host: string, port: number): Promise<void> {
    await invoke("still_forget_host", { args: { host, port } })
  },

  async hasCredential(host: string, port: number, username: string) {
    return invoke<boolean>("still_has_secret", {
      args: { host, port, username },
    })
  },

  async forgetCredential(host: string, port: number, username: string) {
    await invoke("still_forget_secret", { args: { host, port, username } })
  },

  async saveKeySecret(keyId: string, keyText: string) {
    await invoke("still_save_key", { args: { keyId }, secret: keyText })
  },
  async hasKeySecret(keyId: string) {
    return invoke<boolean>("still_has_key", { args: { keyId } })
  },
  async forgetKeySecret(keyId: string) {
    await invoke("still_forget_key", { args: { keyId } })
  },

  async windowMinimize() {
    await getCurrentWindow().minimize()
  },
  async windowToggleMaximize() {
    await getCurrentWindow().toggleMaximize()
  },
  async windowClose() {
    await getCurrentWindow().close()
  },
  async windowStartDrag() {
    await getCurrentWindow().startDragging()
  },
}
