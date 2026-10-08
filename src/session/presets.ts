// Connection presets for the new-session form. Metadata only — never secrets.
// Persisted separately from the M2 store so the session store schema stays put.

import type { AuthMethod } from "../types"

const PRESETS_KEY = "still.session-presets.v1"
const MAX_PRESETS = 12

export interface SessionPreset {
  id: string
  label: string
  host: string
  port: string
  username: string
  workingDirectory: string
  authMethod: AuthMethod
}

export const BUILTIN_PRESETS: SessionPreset[] = [
  {
    id: "builtin-local",
    label: "Local",
    host: "localhost",
    port: "22",
    username: "",
    workingDirectory: "~",
    authMethod: "ask",
  },
  {
    id: "builtin-blank",
    label: "Custom",
    host: "",
    port: "22",
    username: "",
    workingDirectory: "~",
    authMethod: "ask",
  },
]

function builtin(id: string): SessionPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id)
}

export function loadPresets(): SessionPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (!raw) return BUILTIN_PRESETS
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return BUILTIN_PRESETS
    // Builtins first (never duplicated); user presets keep insertion order.
    const user = parsed.filter(
      (p): p is SessionPreset =>
        !!p && typeof p === "object" && typeof (p as SessionPreset).host === "string",
    )
    return [...BUILTIN_PRESETS, ...user.filter((p) => !builtin(p.id))].slice(0, MAX_PRESETS)
  } catch {
    return BUILTIN_PRESETS
  }
}

export function savePresets(presets: SessionPreset[]): SessionPreset[] {
  const kept = presets.slice(0, MAX_PRESETS)
  try {
    // Only user presets persist; builtins are re-added by loadPresets.
    localStorage.setItem(PRESETS_KEY, JSON.stringify(kept.filter((p) => !builtin(p.id))))
  } catch {
    // Storage full/blocked: keep in-memory copy for this run.
  }
  return kept
}

export function presetLabel(host: string, username: string): string {
  const h = host.trim()
  const u = username.trim()
  if (u && h) return `${u}@${h}`
  return h || "Preset"
}
