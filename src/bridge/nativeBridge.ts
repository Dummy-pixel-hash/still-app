import type { ConnectionStatus } from "../types"

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
export interface NativeBridge {
  readonly adapterName: string
  readonly isDevelopmentAdapter: boolean

  /** IPC round-trip probe: React -> Tauri IPC -> Rust -> response -> React. */
  ping(): Promise<{ status: string; app: string; version: string }>

  connect(args: ConnectArgs): Promise<ConnectResult>
  write(sessionId: string, data: string | Uint8Array): Promise<void>
  resize(sessionId: string, cols: number, rows: number): Promise<void>
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
  adapterName: "No native runtime (packaging error)",
  isDevelopmentAdapter: false,
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
}
