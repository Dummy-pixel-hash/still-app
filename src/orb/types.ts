import type { ConnState } from "../types"

/** Rendering vocabulary, not a claim that an agent detector exists. */
export type OrbVisualState = "idle" | "working" | "needs-input" | "done" | "error" | "unknown"
export type OrbSize = 48 | 64 | 96
export interface OrbPreferences {
  enabled: boolean
  size: OrbSize
  paused: boolean
}

/** Only facts currently observable by Still. No inferred agent completion. */
export type OrbConnectionSignal = "connected" | "connecting" | "auth" | "host-key" | "host-key-changed" | "error"
export interface OrbRow {
  sessionId: string
  name: string
  signal: OrbConnectionSignal
  changedAt: number
  lastOutputAt: number | null
}

export interface OrbSnapshot {
  revision: number
  publishedAt: number
  preferences: OrbPreferences
  rows: OrbRow[]
}

export type OrbCommand =
  | { type: "open"; sessionId?: string }
  | { type: "workspace" }
  | { type: "hide" }
  | { type: "pause"; paused: boolean }
  | { type: "reset" }
  | { type: "drag" }
  | { type: "focus" }
  | { type: "nudge"; dx: number; dy: number }
  | { type: "menu" }

export type OrbAction =
  | { type: "open"; sessionId: string | null }
  | { type: "preferences"; preferences: OrbPreferences }
  | { type: "reset" }

export interface OrbBridge {
  orbConfigure(preferences: OrbPreferences): Promise<OrbSnapshot>
  orbPublish(rows: OrbRow[]): Promise<void>
  orbSnapshot(): Promise<OrbSnapshot>
  subscribeOrbSnapshot(callback: (snapshot: OrbSnapshot) => void): Promise<() => void>
  subscribeOrbActions(callback: (action: OrbAction) => void): Promise<() => void>
  orbCommand(command: OrbCommand): Promise<void>
}

/** Publisher input is deliberately smaller than a persisted Session. */
export interface OrbSessionInput {
  id: string
  name: string
  connection: ConnState
  nativeId: string | null
  attention: "auth" | "host-key" | "host-key-changed" | null
  changedAt: number
}
