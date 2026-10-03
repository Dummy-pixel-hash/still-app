import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
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
    return invoke<{ status: string; app: string; version: string }>(
      "still_ping",
    )
  },

  async connect(args: ConnectArgs): Promise<ConnectResult> {
    return invoke<ConnectResult>("still_connect", { args })
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
    return invoke<StatusResult>("still_status", { args: { sessionId } })
  },

  async subscribeToSession(sessionId, callback) {
    const unlisten = await listen<NativeSessionEvent>(
      `still://session-event/${sessionId}`,
      (event) => callback(event.payload),
    )
    return unlisten
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
