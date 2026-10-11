// Connection presets for the new-session form. Metadata only — never secrets.
// Persisted separately from the M2 store so the session store schema stays put.
//
// A preset is identified by its user-given `name` (e.g. "Prod FRA").
// Connection fields (host/port/user/dir) are filled from the preset on apply.
// Legacy presets stored only `label` (user@host) are migrated to `name`.

export const PRESETS_KEY = "still.session-presets.v1"
export const MAX_PRESETS = 12

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

export function builtin(id: string): SessionPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id)
}

/** True for the two built-in entries that are never persisted or deleted. */
export function isBuiltinPreset(id: string): boolean {
  return id.startsWith("builtin-") || builtin(id) !== undefined
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
    // MAX_PRESETS caps user entries only — builtins never eat the budget.
    const user = (parsed as LegacyPreset[])
      .map((p, i) => normalize(p, i))
      .filter((p): p is SessionPreset => p !== null && !isBuiltinPreset(p.id))
      .slice(0, MAX_PRESETS)
    return [...BUILTIN_PRESETS, ...user]
  } catch {
    return BUILTIN_PRESETS
  }
}

export function savePresets(presets: SessionPreset[]): SessionPreset[] {
  // Filter builtins BEFORE capping so the cap applies to user presets only.
  const usersOnly = presets.filter((p) => !isBuiltinPreset(p.id))
  const keptUsers = usersOnly.slice(0, MAX_PRESETS)
  try {
    // Only user presets persist; builtins are re-added by loadPresets.
    localStorage.setItem(PRESETS_KEY, JSON.stringify(keptUsers))
  } catch {
    // Storage full/blocked: keep in-memory copy for this run.
  }
  return [...BUILTIN_PRESETS, ...keptUsers]
}

export interface PresetDraftFields {
  name: string
  host: string
  port: string
  username: string
  workingDirectory: string
  /** Fallback display name when the name field is empty (e.g. wizard search). */
  queryFallback?: string
}

/**
 * Insert-or-update a user preset from wizard/session fields.
 * Match is case-insensitive on trimmed `name`; updates reuse the existing
 * `id` and move to the front (most-recent-first). No-op when host is blank.
 * Persists via savePresets and returns the full list (builtins + users).
 */
export function upsertPreset(
  prev: SessionPreset[],
  fields: PresetDraftFields,
): SessionPreset[] {
  const host = fields.host.trim()
  if (!host) return prev
  const username = fields.username.trim()
  const workingDirectory = fields.workingDirectory.trim() || "~"
  const name =
    fields.name.trim() || (fields.queryFallback ?? "").trim() || host
  if (!name) return prev
  const key = name.toLowerCase()
  const existing = prev.find(
    (p) => !isBuiltinPreset(p.id) && p.name.trim().toLowerCase() === key,
  )
  if (existing) {
    const updated: SessionPreset = {
      ...existing,
      name,
      host,
      port: fields.port,
      username,
      workingDirectory,
    }
    const rest = prev.filter((p) => p.id !== existing.id)
    // Drop any other case-variant duplicate of the same name.
    const deduped = rest.filter(
      (p) => isBuiltinPreset(p.id) || p.name.trim().toLowerCase() !== key,
    )
    return savePresets([updated, ...deduped])
  }
  const created: SessionPreset = {
    id: `preset-${Date.now().toString(36)}`,
    name,
    host,
    port: fields.port,
    username,
    workingDirectory,
  }
  const deduped = prev.filter(
    (p) => isBuiltinPreset(p.id) || p.name.trim().toLowerCase() !== key,
  )
  return savePresets([created, ...deduped])
}

/** Display line for a dropdown option: "Name — user@host:port". */
export function presetDetail(p: SessionPreset): string {
  const target = p.host ? `${p.username ? `${p.username}@` : ""}${p.host}:${p.port || "22"}` : "blank"
  return `${p.name} — ${target}`
}
