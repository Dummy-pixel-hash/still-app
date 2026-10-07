// Still M2 — local metadata store.
//
// Persisted (localStorage `still.m2.store.v1`): projects, sessions (WITHOUT
// secrets), key metadata (WITHOUT key text), settings, card order.
// NEVER persisted: passwords, private keys, passphrases — those live only in
// transient connect-time state and the OS keyring (native side).

import { useCallback, useEffect, useState } from "react"
import {
  blankDraft,
  newSessionId,
  tmuxNameFor,
  type AppSettings,
  type KeyEntry,
  type Project,
  type Session,
  type SessionDraft,
} from "../types"

const STORE_KEY = "still.m2.store.v1"

interface StoreShape {
  projects: Project[]
  sessions: Session[]
  order: Record<string, string[]>
  keys: KeyEntry[]
  settings: AppSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  confirmRemove: true,
  terminal: { fontSize: 14, cursorStyle: "block", scrollback: 5000 },
}

function seed(): StoreShape {
  const now = Date.now()
  return {
    projects: [
      { id: "atlas", name: "Atlas", note: "Payments API · production", order: 0 },
      { id: "lab", name: "Home Lab", note: "Proxmox cluster · 3 nodes", order: 1 },
    ],
    sessions: [
      {
        id: "seed-atlas-shell",
        name: "Shell",
        host: "",
        port: 22,
        username: "",
        projectId: "atlas",
        workingDirectory: "~",
        authMethod: "ask",
        remember: false,
        tmuxSession: "still-shell",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "seed-lab-shell",
        name: "Shell",
        host: "",
        port: 22,
        username: "",
        projectId: "lab",
        workingDirectory: "~",
        authMethod: "ask",
        remember: false,
        tmuxSession: "still-maintenance",
        createdAt: now,
        updatedAt: now,
      },
    ],
    order: {
      atlas: ["seed-atlas-shell"],
      lab: ["seed-lab-shell"],
    },
    keys: [],
    settings: DEFAULT_SETTINGS,
  }
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
            return rest as unknown as StoreShape["sessions"][number]
          })
        : [],
      order: parsed.order ?? {},
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    }
  } catch {
    return seed()
  }
}

let cached: StoreShape | null = null
function getStore(): StoreShape {
  if (!cached) cached = load()
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
  persist({ ...store, settings: { ...store.settings, ...patch } })
  notify()
}

export function updateTerminalPrefs(patch: Partial<AppSettings["terminal"]>) {
  const store = getStore()
  persist({
    ...store,
    settings: {
      ...store.settings,
      terminal: { ...store.settings.terminal, ...patch },
    },
  })
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
