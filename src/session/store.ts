// Still M2 — local metadata store.
//
// Persisted (localStorage `still.m2.store.v1`): projects, sessions (WITHOUT
// secrets), key metadata (WITHOUT key text), settings, card order.
// NEVER persisted: passwords, private keys, passphrases — those live only in
// transient connect-time state and the OS keyring (native side).

import { useCallback, useEffect, useState } from "react"
import { DEFAULT_ORB_PREFERENCES, normalizeOrbPreferences } from "../orb/state"
import { isTerminalPreview, TERMINAL_PREVIEW_STORE_KEY } from "../preview/mode"
import {
  CUSTOM_PREFIX,
  DEFAULT_TERMINAL_PREFS,
  MAX_CUSTOM_THEMES,
  STILL_THEME_ID,
  normalizeCustomThemes,
  normalizeSessionAppearance,
  normalizeTerminalPrefs,
  normalizeTheme,
  presetTheme,
  type SessionAppearance,
  type TerminalPalette,
  type TerminalTheme,
} from "../terminal/appearance"
import {
  blankDraft,
  newSessionId,
  tmuxNameFor,
  terminalScrollback,
  type AppSettings,
  type KeyEntry,
  type Project,
  type Session,
  type SessionDraft,
} from "../types"

// Demo edits stay separate from the user's saved projects and terminals.
const STORE_KEY = isTerminalPreview() ? TERMINAL_PREVIEW_STORE_KEY : "still.m2.store.v1"

interface StoreShape {
  projects: Project[]
  sessions: Session[]
  order: Record<string, string[]>
  keys: KeyEntry[]
  settings: AppSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  confirmRemove: true,
  terminal: { ...DEFAULT_TERMINAL_PREFS },
  imageInsertStyle: "path",
  orb: { ...DEFAULT_ORB_PREFERENCES },
  customThemes: [],
}

function seed(): StoreShape {
  return {
    // First run starts empty: the workspace shows the onboarding panel
    // (no fake Atlas/Home Lab projects the user never created).
    projects: [],
    sessions: [],
    order: {},
    keys: [],
    settings: DEFAULT_SETTINGS,
  }
}

// One-time purge of the shipped placeholder content (Atlas/Home Lab +
// seed shells) the user never created. Matches exact seed IDs only —
// user data is untouched. A seed project is dropped only when it holds
// nothing but seed sessions, so anything a user created survives.
const SEED_PROJECT_IDS = new Set(["atlas", "lab"])
const SEED_SESSION_IDS = new Set(["seed-atlas-shell", "seed-lab-shell"])

function purgeShippedSeeds(store: StoreShape): StoreShape {
  const sessions = store.sessions.filter((s) => !SEED_SESSION_IDS.has(s.id))
  const projects = store.projects.filter(
    (p) =>
      !SEED_PROJECT_IDS.has(p.id) ||
      store.sessions.some(
        (s) => s.projectId === p.id && !SEED_SESSION_IDS.has(s.id),
      ),
  )
  if (
    sessions.length === store.sessions.length &&
    projects.length === store.projects.length
  )
    return store
  const live = new Set(projects.map((p) => p.id))
  const kept = new Set(sessions.map((s) => s.id))
  const order: Record<string, string[]> = {}
  for (const [pid, ids] of Object.entries(store.order))
    if (live.has(pid)) order[pid] = ids.filter((id) => kept.has(id))
  const next = { ...store, sessions, projects, order }
  persist(next)
  return next
}

function load(): StoreShape {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return seed()
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : seed().projects,
      // Migration: drop legacy `kind` (session-kind presets removed).
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.map((s) => {
            const { kind: _legacyKind, ...rest } = s as unknown as Record<string, unknown>
            void _legacyKind
            // Existing sessions were all SSH sessions, including localhost
            // entries. Never infer local execution from a hostname.
            const { terminalTheme: _t, fontSize: _f, ...plain } = rest
            void _t
            void _f
            return {
              ...plain,
              ...normalizeSessionAppearance(rest),
              transport: rest.transport === "local" ? "local" : "ssh",
            } as unknown as StoreShape["sessions"][number]
          })
        : [],
      order: parsed.order ?? {},
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      settings: {
        ...DEFAULT_SETTINGS,
        ...(parsed.settings ?? {}),
        terminal: normalizeTerminalPrefs(parsed.settings?.terminal),
        customThemes: normalizeCustomThemes(parsed.settings?.customThemes),
        // Deleted legacy orb settings never re-enable the new companion.
        orb: normalizeOrbPreferences(parsed.settings?.orb),
      },
    }
  } catch {
    return seed()
  }
}

let cached: StoreShape | null = null
function getStore(): StoreShape {
  if (!cached) cached = purgeShippedSeeds(load())
  return cached
}

function persist(store: StoreShape) {
  cached = store
  try {
    // Strip any accidental secret-shaped fields before writing.
    const safe: StoreShape = {
      ...store,
      sessions: store.sessions.map((s) => ({ ...s })),
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(safe))
  } catch {
    // Storage full/blocked: keep in-memory copy.
  }
}

function notify() {
  window.dispatchEvent(new CustomEvent("still-store"))
}

export function useStore(): StoreShape & { version: number } {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    window.addEventListener("still-store", bump)
    window.addEventListener("storage", bump)
    return () => {
      window.removeEventListener("still-store", bump)
      window.removeEventListener("storage", bump)
    }
  }, [])
  const store = getStore()
  return { ...store, version }
}

// --- projects ---

export function createProject(name: string, note = ""): Project {
  const store = getStore()
  const project: Project = {
    id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || "Untitled project",
    note,
    order: store.projects.length,
  }
  persist({
    ...store,
    projects: [...store.projects, project],
    order: { ...store.order, [project.id]: [] },
  })
  notify()
  return project
}

/**
 * Delete a project and every session inside it. Returns the removed
 * sessions so the caller can release their live workers first.
 */
export function removeProject(id: string): Session[] {
  const store = getStore()
  const removed = store.sessions.filter((s) => s.projectId === id)
  const { [id]: _dropped, ...order } = store.order
  void _dropped
  persist({
    ...store,
    projects: store.projects.filter((p) => p.id !== id),
    sessions: store.sessions.filter((s) => s.projectId !== id),
    order,
  })
  notify()
  return removed
}

// --- sessions ---

export interface SessionInput extends SessionDraft {
  tmuxSession?: string
}

export function validateDraft(d: SessionDraft): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!d.name.trim()) errors.name = "Name is required"
  if (!d.host.trim()) errors.host = "Host is required"
  const port = Number.parseInt(d.port, 10)
  if (!d.port.trim() || Number.isNaN(port) || port < 1 || port > 65535)
    errors.port = "Port must be 1–65535"
  if (!d.username.trim()) errors.username = "Username is required"
  if (!d.projectId) errors.projectId = "Project is required"
  if (d.authMethod === "key" && !d.keyId) errors.keyId = "Choose a key"
  return errors
}

export function createSession(input: SessionInput): Session {
  const store = getStore()
  const now = Date.now()
  const session: Session = {
    id: newSessionId(),
    name: input.name.trim(),
    host: input.host.trim(),
    port: Number.parseInt(input.port, 10) || 22,
    username: input.username.trim(),
    projectId: input.projectId,
    workingDirectory: input.workingDirectory.trim() || "~",
    authMethod: input.authMethod,
    keyId: input.authMethod === "key" ? input.keyId || undefined : undefined,
    remember: input.remember,
    tmuxSession:
      input.tmuxSession?.trim() ||
      `${tmuxNameFor(input.name)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: now,
    updatedAt: now,
  }
  const order = [
    ...(store.order[session.projectId] ?? store.sessions.filter((s) => s.projectId === session.projectId).map((s) => s.id)),
    session.id,
  ]
  persist({
    ...store,
    sessions: [...store.sessions, session],
    order: { ...store.order, [session.projectId]: order },
  })
  notify()
  return session
}

export function updateSession(
  id: string,
  patch: Partial<Omit<Session, "id" | "createdAt" | "tmuxSession">>,
): Session | null {
  const store = getStore()
  const existing = store.sessions.find((s) => s.id === id)
  if (!existing) return null
  // tmuxSession is identity: never changed by edit.
  const next: Session = {
    ...existing,
    ...patch,
    id: existing.id,
    tmuxSession: existing.tmuxSession,
    updatedAt: Date.now(),
  }
  persist({
    ...store,
    sessions: store.sessions.map((s) => (s.id === id ? next : s)),
  })
  notify()
  return next
}

export function removeSession(id: string) {
  const store = getStore()
  const target = store.sessions.find((s) => s.id === id)
  persist({
    ...store,
    sessions: store.sessions.filter((s) => s.id !== id),
    order: Object.fromEntries(
      Object.entries(store.order).map(([pid, ids]) => [
        pid,
        ids.filter((sid) => sid !== id),
      ]),
    ),
  })
  notify()
  return target
}

export function moveSession(sessionId: string, toProjectId: string, beforeId?: string) {
  const store = getStore()
  const stripped: Record<string, string[]> = Object.fromEntries(
    Object.entries(store.order).map(([pid, ids]) => [
      pid,
      ids.filter((sid) => sid !== sessionId),
    ]),
  )
  const list = [...(stripped[toProjectId] ?? [])]
  const at = beforeId ? list.indexOf(beforeId) : -1
  list.splice(at < 0 ? list.length : at, 0, sessionId)
  stripped[toProjectId] = list
  const sessions = store.sessions.map((s) =>
    s.id === sessionId ? { ...s, projectId: toProjectId, updatedAt: Date.now() } : s,
  )
  persist({ ...store, sessions, order: stripped })
  notify()
}

export function reorderSession(sessionId: string, projectId: string, ids: string[]) {
  const store = getStore()
  persist({ ...store, order: { ...store.order, [projectId]: ids } })
  notify()
}

export function touchSession(id: string) {
  const store = getStore()
  persist({
    ...store,
    sessions: store.sessions.map((s) =>
      s.id === id ? { ...s, lastOpenedAt: Date.now(), updatedAt: Date.now() } : s,
    ),
  })
  notify()
}

// --- keys (metadata only) ---

export function addKey(name: string): KeyEntry {
  const store = getStore()
  const entry: KeyEntry = {
    id: `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || "Untitled key",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  persist({ ...store, keys: [...store.keys, entry] })
  notify()
  return entry
}

export function renameKey(id: string, name: string) {
  const store = getStore()
  persist({
    ...store,
    keys: store.keys.map((k) =>
      k.id === id ? { ...k, name: name.trim() || k.name, updatedAt: Date.now() } : k,
    ),
  })
  notify()
}

export function removeKey(id: string) {
  const store = getStore()
  persist({ ...store, keys: store.keys.filter((k) => k.id !== id) })
  notify()
}

// --- settings ---

export function updateSettings(patch: Partial<AppSettings>) {
  const store = getStore()
  const settings = { ...store.settings, ...patch }
  if ("terminal" in patch) settings.terminal = normalizeTerminalPrefs(settings.terminal)
  if ("customThemes" in patch) settings.customThemes = normalizeCustomThemes(patch.customThemes)
  if ("orb" in patch) settings.orb = normalizeOrbPreferences(patch.orb)
  persist({ ...store, settings })
  notify()
}

export function updateTerminalPrefs(patch: Partial<AppSettings["terminal"]>) {
  updateSettings({ terminal: { ...getStore().settings.terminal, ...patch } })
}

// --- terminal themes -----------------------------------------------------------

// Temp (`temp-*`) sessions are memory-only and never in the store: their
// overrides live here and vanish with the page.
const tempAppearance = new Map<string, SessionAppearance>()

export function tempAppearanceFor(id: string): SessionAppearance | undefined {
  return tempAppearance.get(id)
}

export function forgetTempAppearance(id: string) {
  tempAppearance.delete(id)
}

let themeSeq = 0
function newThemeId(): string {
  themeSeq += 1
  return `${CUSTOM_PREFIX}${Date.now().toString(36)}-${themeSeq}-${Math.random().toString(36).slice(2, 6)}`
}

/** Create a custom theme (optionally duplicating `from`). Returns null at the cap. */
export function createCustomTheme(name: string, from?: Pick<TerminalTheme, "colors" | "kind" | "id" | "previewForeground" | "basedOn">): TerminalTheme | null {
  const store = getStore()
  if (store.settings.customThemes.length >= MAX_CUSTOM_THEMES) return null
  const source = from ?? presetTheme(STILL_THEME_ID)!
  const theme = normalizeTheme({
    id: newThemeId(),
    name,
    kind: source.kind,
    colors: source.colors,
    basedOn: presetTheme(source.id) ? source.id : source.basedOn,
    previewForeground: source.previewForeground,
  })
  if (!theme) return null
  updateSettings({ customThemes: [...store.settings.customThemes, theme] })
  return theme
}

export function updateCustomTheme(
  id: string,
  patch: { name?: string; colors?: Partial<TerminalPalette>; kind?: TerminalTheme["kind"] },
) {
  const store = getStore()
  const existing = store.settings.customThemes.find((t) => t.id === id)
  if (!existing) return
  const next = normalizeTheme({
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.kind ? { kind: patch.kind } : {}),
    colors: { ...existing.colors, ...(patch.colors ?? {}) },
  })
  if (!next) return
  updateSettings({ customThemes: store.settings.customThemes.map((t) => (t.id === id ? next : t)) })
}

export function setDefaultTheme(id: string) {
  updateTerminalPrefs({ themeId: id })
}

/** Remove a custom theme; sessions using it fall back to the default. */
export function deleteCustomTheme(id: string) {
  const store = getStore()
  if (!store.settings.customThemes.some((t) => t.id === id)) return
  const sessions = store.sessions.map((s) => {
    if (s.terminalTheme !== id) return s
    const { terminalTheme: _gone, ...rest } = s
    void _gone
    return rest as Session
  })
  for (const [tid, a] of tempAppearance) if (a.terminalTheme === id) tempAppearance.set(tid, { ...a, terminalTheme: undefined })
  const terminal = store.settings.terminal.themeId === id ? { ...store.settings.terminal, themeId: STILL_THEME_ID } : store.settings.terminal
  persist({
    ...store,
    sessions,
    settings: { ...store.settings, terminal, customThemes: store.settings.customThemes.filter((t) => t.id !== id) },
  })
  notify()
}

/** Number of saved sessions whose override uses this theme. */
export function sessionsUsingTheme(id: string): number {
  return getStore().sessions.filter((s) => s.terminalTheme === id).length
}

/**
 * Set or clear (value `undefined`) a session's theme / font override. Never
 * bumps `updatedAt`: that would remount the terminal (it is part of the
 * surface key) and reorder "recent".
 */
export function setSessionAppearance(id: string, patch: { terminalTheme?: string | undefined; fontSize?: number | undefined }) {
  const hasTheme = "terminalTheme" in patch
  const hasFont = "fontSize" in patch
  if (id.startsWith("temp-")) {
    const cur = tempAppearance.get(id) ?? {}
    const next: SessionAppearance = { ...cur }
    if (hasTheme) next.terminalTheme = patch.terminalTheme
    if (hasFont) next.fontSize = patch.fontSize
    tempAppearance.set(id, normalizeSessionAppearance(next))
    notify()
    return
  }
  const store = getStore()
  const existing = store.sessions.find((s) => s.id === id)
  if (!existing) return
  const next = { ...existing } as Session
  if (hasTheme) {
    if (patch.terminalTheme) next.terminalTheme = patch.terminalTheme
    else delete next.terminalTheme
  }
  if (hasFont) {
    const font = normalizeSessionAppearance({ fontSize: patch.fontSize }).fontSize
    if (font !== undefined) next.fontSize = font
    else delete next.fontSize
  }
  persist({ ...store, sessions: store.sessions.map((s) => (s.id === id ? next : s)) })
  notify()
}

export { blankDraft }

export function useDraft(initialProjectId = "") {
  const [draft, setDraft] = useState<SessionDraft>(() => blankDraft(initialProjectId))
  const set = useCallback(
    <K extends keyof SessionDraft>(key: K, value: SessionDraft[K]) =>
      setDraft((d) => ({ ...d, [key]: value })),
    [],
  )
  return { draft, set, setDraft }
}
