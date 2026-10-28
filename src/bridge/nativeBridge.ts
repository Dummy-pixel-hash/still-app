import type { ConnectionStatus } from "../types"
import type { OrbBridge } from "../orb/types"
import type { AgentAvailability, AgentCatalog, AgentLaunchOptions, AgentLibrary, AgentThreadEvent, AgentThreadSnapshot } from "../agents/types"
import type { ConversationMeta } from "../agents/workspace"

import { unavailableAgentBridge } from "./agentMocks"



/**
 * Bitmap-only clipboard fallback: paste events sometimes carry no file item
 * and no text (screenshots on some WebViews, and all of WebKitGTK on Linux
 * where ClipboardEvent.clipboardData is always empty). In a Tauri runtime
 * prefer the native plugin first (no permission prompt, no transient-
 * activation expiry); the async web Clipboard API is the browser-preview
 * fallback only. Returns a PNG File or null. Never throws.
 */
export async function readClipboardImageFile(): Promise<File | null> {
  if ("__TAURI__" in window) {
    try {
      const { readImage } = await import("@tauri-apps/plugin-clipboard-manager")
      const image = await readImage()
      const [rgba, { width, height }] = await Promise.all([image.rgba(), image.size()])
      try {
        if (!width || !height || rgba.length !== width * height * 4) return null
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d")
        if (!ctx) return null
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
        const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
        if (!blob?.size) return null
        return new File([blob], "still-paste.png", { type: "image/png" })
      } finally {
        await image.close().catch(() => {})
      }
    } catch {
      // No image in clipboard (plugin throws) — fall through to web API
      // which may still have it, then null.
    }
  }
  try {
    const items = await navigator.clipboard?.read?.()
    for (const item of items ?? []) {
      const mime = item.types.find((t) => t.startsWith("image/"))
      if (!mime) continue
      const blob = await item.getType(mime)
      if (blob?.size) return new File([blob], "still-paste.png", { type: "image/png" })
    }
  } catch {
    // Async clipboard unavailable/denied.
  }
  if ("__TAURI__" in window) return null
  try {
    const { readImage } = await import("@tauri-apps/plugin-clipboard-manager")
    const image = await readImage()
    const [rgba, { width, height }] = await Promise.all([image.rgba(), image.size()])
    try {
      if (!width || !height || rgba.length !== width * height * 4) return null
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")
      if (!ctx) return null
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
      if (!blob?.size) return null
      return new File([blob], "still-paste.png", { type: "image/png" })
    } finally {
      await image.close().catch(() => {})
    }
  } catch {
    return null
  }
}

export type Unsubscribe = () => void

/** Auth method selected in the renderer. The secret itself is passed per-call only. */
export type AuthKind = "password" | "privateKey"

/** Arguments for establishing a native SSH+tmux session. */
export interface ConnectArgs {
  host: string
  port: number
  username: string
  authKind: AuthKind
  /** Password text or PEM-encoded private key. Never persisted by the renderer. */
  secret?: string
  /** Ask Rust to persist the secret in the OS keyring. */
  remember?: boolean
  /** Desired remote tmux session name (sanitized natively). */
  tmuxSession?: string
  /** Remote start directory for a newly created tmux session. */
  workingDirectory?: string
  /** Authenticate SSH without creating a PTY or attaching a tmux session. */
  sshOnly?: boolean
  cols?: number
  rows?: number
  clientId?: string
}

export interface ConnectResult {
  sessionId: string
  status: ConnectionStatus
}

/** M5: server host-key identity shown for an explicit trust decision. No secrets. */
export interface HostKeyPrompt {
  host: string
  port: number
  keyType: string
  fingerprint: string
  opensshKey: string
  /** true = stored key differs (possible MITM); false = never-seen host. */
  changed: boolean
}

/** Native session event payloads: `{ type: 'data' | 'status' | 'error' | 'hostKeyPrompt', ... }`. */
export type NativeSessionEvent =
  | { type: "data"; data: number[] }
  | { type: "status"; status: ConnectionStatus }
  | {
      type: "error"
      error: { code: string; message: string; field?: string }
    }
  | { type: "hostKeyPrompt"; prompt: HostKeyPrompt }

/** M5: live host-key identity + trust state. No secrets. */
export interface HostKeyInfo {
  host: string
  port: number
  keyType: string
  fingerprint: string
  opensshKey: string
  /** null = never trusted; true = matches trust; false = CHANGED. */
  trusted: boolean | null
}

export interface StatusResult {
  status: ConnectionStatus
  lastError: { code: string; message: string; field?: string } | null
}

/**
 * Renderer-side contract for the native layer.
 *
 * The UI depends on this interface — never on Tauri imports directly.
 * Session lifecycle: connect -> write/resize -> disconnect -> reconnect.
 * Secrets cross this boundary per-call only and are never stored in JS
 * (except transient connect-time form state, cleared after use).
 */
export interface NativeBridge extends OrbBridge {
  readonly adapterName: string
  readonly isDevelopmentAdapter: boolean

  agentLibrary(): Promise<AgentLibrary>
  agentFlush(): Promise<void>
  agentSaveMetadata(conversationId: string, meta: ConversationMeta): Promise<void>
  agentSaveWorkspace(key: string, value: object): Promise<void>
  agentDeleteSaved(conversationId: string): Promise<void>
  agentMigrate(rows: unknown[], deleted: string[], workspaces: object): Promise<string[]>
  subscribeAgentStorage(callback: (event: { conversationId: string; sequence: number; error?: string }) => void): Promise<Unsubscribe>
  agentCatalog(nativeSessionId: string, agentId: string, cwd: string, executable?: string): Promise<AgentCatalog>
  agentResolveFolder(nativeSessionId: string, cwd: string): Promise<string>

  agentStart(nativeSessionId:string,localSessionId:string,agentId:string,options?:AgentLaunchOptions):Promise<AgentThreadSnapshot>
  agentCheck(nativeSessionId:string,agentId?:string,executable?:string):Promise<AgentAvailability[]>
  agentSend(executionId:string,message:string):Promise<void>
  agentRevert(executionId:string,messageId:string,expectedSequence:number):Promise<AgentThreadSnapshot>
  agentSetConfig(executionId:string,configId:string,value:string|boolean):Promise<void>
  agentRespondPermission(executionId:string,requestId:string|number,optionId:string):Promise<void>
  agentCancel(executionId:string):Promise<void>
  agentClose(executionId:string):Promise<void>
  agentRespondInput(executionId:string,requestId:string|number,answers:Record<string,unknown>|null):Promise<void>
  agentSnapshot(executionId:string):Promise<AgentThreadSnapshot>
  subscribeToAgent(executionId:string,callback:(event:AgentThreadEvent)=>void):Promise<Unsubscribe>

  /** Open an http(s) URL in the OS default browser. */
  openExternal(url: string): Promise<void>

  /** IPC round-trip probe: React -> Tauri IPC -> Rust -> response -> React. */
  ping(): Promise<{ status: string; app: string; version: string }>

  connect(args: ConnectArgs): Promise<ConnectResult>
  write(sessionId: string, data: string | Uint8Array): Promise<void>
  resize(sessionId: string, cols: number, rows: number): Promise<void>
  /** Out-of-band repaint: makes tmux resend the visible screen. Best-effort. */
  refresh(sessionId: string): Promise<void>
  disconnect(sessionId: string): Promise<void>
  status(sessionId: string): Promise<StatusResult>
  subscribeToSession(
    sessionId: string,
    callback: (event: NativeSessionEvent) => void,
  ): Promise<Unsubscribe>

  hasCredential(host: string, port: number, username: string): Promise<boolean>
  forgetCredential(host: string, port: number, username: string): Promise<void>

  // --- M5 host-key verification (Rust is authoritative; renderer never verifies) ---
  /** Fetch the live server host key without authenticating. Never sends credentials. */
  probeHost(host: string, port: number): Promise<HostKeyInfo>
  /** Explicit trust: Rust re-probes the live key and stores it only if unchanged. */
  trustHost(host: string, port: number, expectedOpenssh: string): Promise<HostKeyInfo>
  /** Remove stored trust for an endpoint. */
  forgetHost(host: string, port: number): Promise<void>

  // --- SSH key library (metadata in renderer, secrets in OS keyring) ---
  /** Persist key text for a library entry id (native keyring only). */
  saveKeySecret(keyId: string, keyText: string): Promise<void>
  /** Whether the OS keyring holds secret text for a library entry id. */
  hasKeySecret(keyId: string): Promise<boolean>
  /** Remove key text for a library entry id from the OS keyring. */
  forgetKeySecret(keyId: string): Promise<void>

  // --- Clipboard (centralized through native bridge) ---
  clipboardWriteText(text: string): Promise<void>
  clipboardReadText(): Promise<string>

  // --- SFTP image upload (bypasses PTY, safe in fullscreen TUIs) ---
  /** Upload base64 image to ~/still-uploads. Returns $HOME-style remote path. */
  uploadImage(sessionId: string, fileName: string, base64Data: string): Promise<{ remotePath: string }>

  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
  windowStartDrag(): Promise<void>
}

// The active adapter is assigned once at startup in main.tsx.
// UI code depends on NativeBridge.
export let nativeBridge: NativeBridge

export function registerNativeBridge(bridge: NativeBridge) {
  nativeBridge = bridge
}

/**
 * PRODUCTION hard-fail adapter.
 *
 * Selected when a production bundle somehow has no Tauri runtime
 * (packaging error, asset served outside the WebView, etc.).
 * Every operation rejects loudly with an explicit diagnostic — the
 * production path can NEVER silently simulate SSH via the mock adapter.
 */
export const failingBridge: NativeBridge = {
  ...unavailableAgentBridge,

  adapterName: "No native runtime (packaging error)",
  isDevelopmentAdapter: false,
  async orbConfigure() { throw new Error("No native runtime: orb companion unavailable.") },
  async orbPublish() { throw new Error("No native runtime: orb companion unavailable.") },
  async orbSnapshot() { throw new Error("No native runtime: orb companion unavailable.") },
  async subscribeOrbSnapshot() { throw new Error("No native runtime: orb companion unavailable.") },
  async subscribeOrbActions() { throw new Error("No native runtime: orb companion unavailable.") },
  async orbCommand() { throw new Error("No native runtime: orb companion unavailable.") },
  async openExternal() { throw new Error("No native runtime: cannot open a browser link.") },
  async ping(): Promise<{ status: string; app: string; version: string }> {
    throw new Error(
      "Still production bundle has no Tauri native runtime: " +
        "cannot reach the SSH engine. Reinstall the application; " +
        "if this persists, the bundle is broken (frontend served outside WebView).",
    )
  },
  async connect(): Promise<ConnectResult> {
    throw new Error(
      "Still production bundle has no Tauri native runtime: " +
        "refusing to simulate an SSH connection.",
    )
  },
  async write(): Promise<void> {
    throw new Error("No native runtime: cannot write to SSH session.")
  },
  async resize(): Promise<void> {
    throw new Error("No native runtime: cannot resize SSH session.")
  },
  async refresh(): Promise<void> {
    throw new Error("No native runtime: cannot repaint SSH session.")
  },
  async disconnect(): Promise<void> {
    throw new Error("No native runtime: nothing to disconnect.")
  },
  async status(): Promise<StatusResult> {
    throw new Error("No native runtime: no session status available.")
  },
  async subscribeToSession(): Promise<Unsubscribe> {
    throw new Error("No native runtime: no session events available.")
  },
  async hasCredential(): Promise<boolean> {
    throw new Error("No native runtime: credential store unreachable.")
  },
  async forgetCredential(): Promise<void> {
    throw new Error("No native runtime: credential store unreachable.")
  },
  async probeHost() {
    throw new Error("No native runtime: host-key verification unavailable.")
  },
  async trustHost() {
    throw new Error("No native runtime: host-key trust unavailable.")
  },
  async forgetHost(): Promise<void> {
    throw new Error("No native runtime: host-key trust store unreachable.")
  },
  async saveKeySecret(): Promise<void> {
    throw new Error("No native runtime: secure storage unreachable.")
  },
  async hasKeySecret(): Promise<boolean> {
    throw new Error("No native runtime: secure storage unreachable.")
  },
  async forgetKeySecret(): Promise<void> {
    throw new Error("No native runtime: secure storage unreachable.")
  },
  async windowMinimize(): Promise<void> {
    throw new Error("No native runtime: window controls unavailable.")
  },
  async windowToggleMaximize(): Promise<void> {
    throw new Error("No native runtime: window controls unavailable.")
  },
  async windowClose(): Promise<void> {
    throw new Error("No native runtime: window controls unavailable.")
  },
  async windowStartDrag(): Promise<void> {
    throw new Error("No native runtime: window controls unavailable.")
  },

  async clipboardWriteText(): Promise<void> {
    throw new Error("No native runtime: clipboard unavailable.")
  },
  async clipboardReadText(): Promise<string> {
    throw new Error("No native runtime: clipboard unavailable.")
  },

  async uploadImage(): Promise<{ remotePath: string }> {
    throw new Error("No native runtime: SFTP upload unavailable.")
  },
}
