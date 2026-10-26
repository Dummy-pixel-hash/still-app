import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager"
import { diagRecord, diagWatchdog } from "../session/diag"
import type { OrbAction, OrbSnapshot } from "../orb/types"
import type { AgentAvailability, AgentLaunchOptions, AgentThreadEvent, AgentThreadSnapshot } from "../agents/types"
import type {
  ConnectArgs,
  ConnectResult,
  NativeBridge,
  NativeSessionEvent,
  StatusResult,
} from "./nativeBridge"

const textEncoder = new TextEncoder()

// Serialize main-window publications/configuration even across StrictMode remounts.
let orbMutations: Promise<unknown> = Promise.resolve()
function serializeOrb<T>(operation: () => Promise<T>): Promise<T> {
  const next = orbMutations.then(operation, operation)
  orbMutations = next.catch(() => {})
  return next
}

/**
 * Production adapter: forwards calls over Tauri IPC to the Rust SSH/tmux
 * engine, and routes `still://session-event/<id>` events back to subscribers.
 * Secrets are passed per-call only and never stored in the renderer.
 */
export const tauriBridge: NativeBridge = {
  adapterName: "Tauri native bridge",
  isDevelopmentAdapter: false,
  agentStart(nativeSessionId:string,localSessionId:string,agentId:string,options?:AgentLaunchOptions):Promise<AgentThreadSnapshot>{return invoke<AgentThreadSnapshot>("still_agent_start",{args:{nativeSessionId,localSessionId,agentId,...options}})},
  agentCheck(nativeSessionId:string,agentId?:string,executable?:string){return invoke<AgentAvailability[]>("still_agent_check",{args:{nativeSessionId,agentId,executable}})},
  agentSend(executionId:string,message:string){return invoke<void>("still_agent_send",{args:{executionId,message}})},
  agentSetConfig(executionId:string,configId:string,value:string|boolean){return invoke<void>("still_agent_set_config",{args:{executionId,configId,value}})},
  agentRespondPermission(executionId:string,requestId:string|number,optionId:string){return invoke<void>("still_agent_respond",{args:{executionId,requestId,optionId}})},
  agentCancel(executionId:string){return invoke<void>("still_agent_cancel",{args:{executionId}})},
  agentClose(executionId:string){return invoke<void>("still_agent_close",{args:{executionId}})},
  agentRespondInput(executionId:string,requestId:string|number,answers:Record<string,unknown>|null){return invoke<void>("still_agent_input",{args:{executionId,requestId,answers}})},
  agentSnapshot(executionId:string){return invoke<AgentThreadSnapshot>("still_agent_snapshot",{args:{executionId}})},
  subscribeToAgent(executionId:string,callback:(event:AgentThreadEvent)=>void){return listen<AgentThreadEvent>(`still://agent-event/${executionId}`,event=>callback(event.payload))},


  orbConfigure(preferences) {
    return serializeOrb(() => invoke<OrbSnapshot>("still_orb_configure", { preferences }))
  },
  orbPublish(rows) {
    return serializeOrb(() => invoke<void>("still_orb_publish", { rows }))
  },
  orbSnapshot() { return invoke<OrbSnapshot>("still_orb_snapshot") },
  subscribeOrbSnapshot(callback) {
    return listen<OrbSnapshot>("still://orb-state", event => callback(event.payload))
  },
  subscribeOrbActions(callback) {
    return listen<OrbAction>("still://orb-action", event => callback(event.payload))
  },
  orbCommand(command) {
    // Pointer-down focus must finish before its click/open or drag action.
    // Tauri dispatches async commands concurrently otherwise, allowing a late
    // focus response to pull focus back from the restored main window.
    return serializeOrb(() => invoke<void>("still_orb_command", { command }))
  },

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
    // Tauri's IPC replacer already expands a nested Uint8Array into a JSON
    // number array, so passing it through avoids a second boxed copy per
    // keystroke (the string branch still has to encode first).
    const bytes = typeof data === "string" ? textEncoder.encode(data) : data
    await invoke("still_write", { args: { sessionId, data: bytes } })
  },

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await invoke("still_resize", { args: { sessionId, cols, rows } })
  },

  async refresh(sessionId: string): Promise<void> {
    await invoke("still_refresh", { args: { sessionId } })
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
}
