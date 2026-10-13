import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager"
import { diagRecord, diagWatchdog } from "../session/diag"
import type {
  ConnectArgs,
  ConnectResult,
  NativeBridge,
  NativeSessionEvent,
  OrbSnapshot,
  SmartConfig,
  SmartProbeResult,
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
    // Trace lifecycle events only. Logging each output chunk added a second
    // IPC round-trip and filesystem write to every TUI redraw.
    const t0 = Date.now()
    diagRecord({ stage: "SUBSCRIBE_START", localId: "", nativeId: sessionId })
    let unlisten: () => void
    try {
      const p = listen<NativeSessionEvent>(
        `still://session-event/${sessionId}`,
        (event) => {
          if (event.payload.type !== "data") {
            diagRecord({
              stage: `EVENT_RECEIVED_${event.payload.type}`,
              localId: "",
              nativeId: sessionId,
            })
          }
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

  // Explicit user copy/paste only; never invoked by remote OSC read queries.
  clipboardWriteText: writeText,
  clipboardReadText: readText,

  async uploadImage(sessionId: string, fileName: string, base64Data: string) {
    const res = await invoke<{ remotePath: string }>("still_upload_image", {
      args: { sessionId, fileName, base64Data },
    })
    return { remotePath: res.remotePath }
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

  // --- Orb companion ---
  async minimizeToOrb() {
    await invoke("still_minimize_to_orb")
  },
  async restoreFromOrb() {
    await invoke("still_restore_from_orb")
  },
  async orbSnapshot(): Promise<OrbSnapshot> {
    return await invoke<OrbSnapshot>("still_orb_snapshot")
  },
  async orbHide() {
    await invoke("still_orb_hide")
  },
  async orbPush(snapshot: OrbSnapshot) {
    await invoke("still_orb_push", { args: { snapshot } })
  },
  async orbStartDrag() {
    await getCurrentWindow().startDragging()
  },
  async orbSetSize(width, height) {
    // Logical px in, logical px out: the old PhysicalSize call fed CSS px
    // as device px, so the hover card landed wrong on any scaled display.
    const { LogicalSize } = await import("@tauri-apps/api/dpi")
    await getCurrentWindow().setSize(new LogicalSize(width, height))
  },
  async orbSetPosition(x, y) {
    const { LogicalPosition } = await import("@tauri-apps/api/dpi")
    await getCurrentWindow().setPosition(new LogicalPosition(x, y))
  },
  async orbGetPosition() {
    return await invoke<{ x: number; y: number }>("still_orb_get_position")
  },
  async orbGetMonitorBounds() {
    try {
      const { currentMonitor } = await import("@tauri-apps/api/window")
      const mon = await currentMonitor()
      if (mon) {
        // workArea = monitor minus taskbar/docks, physical pixels.
        const { position } = mon
        const area = mon.workArea ?? mon.position
        return {
          x: area.position.x,
          y: area.position.y,
          width: area.size.width,
          height: area.size.height,
        }
      }
    } catch {
      /* fall through to a conservative default */
    }
    return { x: 0, y: 0, width: 1280, height: 720 }
  },
  async hooksInstall(sessionId, agent) {
    return await invoke<{ status: string; detail: string }>("still_hooks_install", {
      args: { sessionId, agent },
    })
  },
  async smartStatus(): Promise<SmartConfig> {
    return await invoke<SmartConfig>("still_orb_smart_status")
  },
  async smartSet(
    patch: Partial<SmartConfig> & { apiKey?: string },
  ): Promise<SmartConfig> {
    const { apiKey, ...rest } = patch
    return await invoke<SmartConfig>("still_orb_smart_set", {
      args: { ...rest, apiKey },
    })
  },
  async smartProbe(
    text,
    endpoint?,
    cutoff?,
    opts?: import("./nativeBridge").SmartProbeOptions,
  ): Promise<SmartProbeResult> {
    return await invoke<SmartProbeResult>("still_orb_smart_probe", {
      args: {
        text,
        endpoint: opts?.endpoint ?? endpoint,
        cutoff: opts?.cutoff ?? cutoff,
        model: opts?.model,
        kind: opts?.kind,
        questionCutoff: opts?.questionCutoff,
        timeoutSecs: opts?.timeoutSecs,
        budgetChars: opts?.budgetChars,
        allowRemote: opts?.allowRemote,
      },
    })
  },
  async smartHasKey(): Promise<boolean> {
    return await invoke<boolean>("still_orb_smart_has_key")
  },
  async smartForgetKey(): Promise<void> {
    await invoke("still_orb_smart_forget_key")
  },
  async quit() {
    await invoke("still_app_exit")
  },
}
