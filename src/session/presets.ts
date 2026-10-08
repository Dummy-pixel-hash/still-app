// Connection presets for the new-session form. Metadata only — never secrets.
// Persisted separately from the M2 store so the session store schema stays put.
//
// A preset is identified by its user-given `name` (e.g. "Prod FRA").
// Connection fields (host/port/user/dir) are filled from the preset on apply.
// Legacy presets stored only `label` (user@host) are migrated to `name`.

const PRESETS_KEY = "still.session-presets.v1"
const MAX_PRESETS = 12

export interface SessionPreset {
  id: string
  /** User-given display name — the primary identifier shown in the dropdown. */
  name: string
  host: string
  port: string
  username: string
  workingDirectory: string
}

export const BUILTIN_PRESETS: SessionPreset[] = [
  {
    id: "builtin-local",
    name: "Local",
    host: "localhost",
    port: "22",
    username: "",
    workingDirectory: "~",
  },
  {
    id: "builtin-blank",
    name: "Custom",
    host: "",
    port: "22",
    username: "",
    workingDirectory: "~",
  },
]

function builtin(id: string): SessionPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id)
}

interface LegacyPreset {
  id?: unknown
  label?: unknown
  name?: unknown
  host?: unknown
  port?: unknown
  username?: unknown
  workingDirectory?: unknown
}

function normalize(raw: LegacyPreset, index: number): SessionPreset | null {
  if (!raw || typeof raw !== "object") return null
  const host = typeof raw.host === "string" ? raw.host : ""
  const label = typeof raw.label === "string" ? raw.label.trim() : ""
  const nameRaw = typeof raw.name === "string" ? raw.name.trim() : ""
  const name = nameRaw || label || host || `Preset ${index + 1}`
  return {
    id:
      typeof raw.id === "string" && raw.id
        ? raw.id
        : `preset-${Date.now().toString(36)}-${index}`,
    name,
    host,
    port: typeof raw.port === "string" ? raw.port : String(raw.port ?? "22"),
    username: typeof raw.username === "string" ? raw.username : "",
    workingDirectory:
      typeof raw.workingDirectory === "string" ? raw.workingDirectory : "~",
  }
}

export function loadPresets(): SessionPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (!raw) return BUILTIN_PRESETS
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return BUILTIN_PRESETS
    // Builtins first (never duplicated); user presets keep insertion order.
    const user = (parsed as LegacyPreset[])
      .map((p, i) => normalize(p, i))
      .filter((p): p is SessionPreset => p !== null && !builtin(p.id))
    return [...BUILTIN_PRESETS, ...user].slice(0, MAX_PRESETS)
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

/** Display line for a dropdown option: "Name — user@host:port". */
export function presetDetail(p: SessionPreset): string {
  const target = p.host ? `${p.username ? `${p.username}@` : ""}${p.host}:${p.port || "22"}` : "blank"
  return `${p.name} — ${target}`
}
