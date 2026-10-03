// Still M2 — product session/project model.

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"

/** Typed response for the `still_ping` IPC probe. */
export interface PingResponse {
  status: string
  app: string
  version: string
}

//
// Session identity (local id, connection fields, tmux name) is persisted in
// renderer storage WITHOUT secrets. Secrets live only in transient memory
// (per-connect prompt) and in the OS keyring via the native bridge.

export type SessionKind = "shell" | "nvim" | "agent" | "lazygit" | "logs" | "btop"

export type AuthMethod = "password" | "key" | "ask"

export type ConnState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"

export interface Session {
  id: string
  name: string
  host: string
  port: number
  username: string
  projectId: string
  workingDirectory: string
  kind: SessionKind
  authMethod: AuthMethod
  /** Local key-library id when authMethod === 'key'. Metadata only, never secret text. */
  keyId?: string
  /** Remember-auth flag for this session (hint for connect flow). */
  remember: boolean
  /** Stable remote tmux identity. Defaults from name; preserved on edit. */
  tmuxSession: string
  createdAt: number
  updatedAt: number
  lastOpenedAt?: number
}

export interface Project {
  id: string
  name: string
  note: string
  order: number
}

export interface TerminalPrefs {
  fontSize: number
  cursorStyle: "block" | "underline" | "bar"
  scrollback: number
}

export interface AppSettings {
  confirmRemove: boolean
  terminal: TerminalPrefs
}

/** Key-library entry: metadata only. Secret text lives in the OS keyring. */
export interface KeyEntry {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface SessionDraft {
  name: string
  host: string
  port: string
  username: string
  projectId: string
  workingDirectory: string
  kind: SessionKind
  authMethod: AuthMethod
  keyId: string
  remember: boolean
}

export const KIND_COMMANDS: Record<SessionKind, string> = {
  nvim: "nvim",
  agent: "claude",
  lazygit: "lazygit",
  logs: "tail -f",
  btop: "btop",
  shell: "zsh",
}

export const KIND_LABELS: Record<SessionKind, string> = {
  shell: "Shell",
  nvim: "Neovim",
  agent: "Agent",
  lazygit: "lazygit",
  logs: "Logs",
  btop: "btop",
}

export function tmuxNameFor(name: string): string {
  // Mirrors native TmuxPlan::sanitize_name: per-char allowlist, '_' fallback.
  let out = ""
  for (const c of name) {
    out += /[A-Za-z0-9._-]/.test(c) ? c : "_"
  }
  return out || "still"
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function blankDraft(projectId = ""): SessionDraft {
  return {
    name: "",
    host: "",
    port: "22",
    username: "",
    projectId,
    workingDirectory: "~",
    kind: "shell",
    authMethod: "ask",
    keyId: "",
    remember: false,
  }
}
