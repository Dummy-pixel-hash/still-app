import type { Session } from "../types"

export const hostKey = (session: Pick<Session, "host" | "port" | "username">) => JSON.stringify([session.host.toLowerCase(), session.port, session.username])
export const agentConnectionId = (session: Session) => `agents:${hostKey(session)}`
export function folderName(cwd: string) { return cwd.split("/").filter(Boolean).pop() || cwd }
export function normalizeFolder(cwd: string) { return cwd === "/" ? cwd : cwd.trim().replace(/\/+$/, "") || "~" }
export interface ConversationMeta {
  id: string
  hostKey: string
  folder: string
  title: string
  pinned: boolean
  archivedAt?: number
  createdAt: number
  activityAt: number
  order: number
  draft: string
}
export interface AgentWorkspacePreferences {
  selectedId?: string
  folder: string
  agent: string
  sort: "recent" | "name" | "manual"
  collapsed: string[]
  folders: string[]
  folderOrder: string[]
  executables: Record<string, string>
  draft: string
}
const key = "still.agents.workspace.v2"
export function readWorkspace(host: string, initialFolder: string): AgentWorkspacePreferences {
  const defaults: AgentWorkspacePreferences = { folder: initialFolder || "~", agent: "opencode", sort: "recent", collapsed: [], folders: [initialFolder || "~"], folderOrder: [], executables: {}, draft: "" }
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "{}")[host]
    if (!saved || typeof saved.folder !== "string") return defaults
    const strings = (value: unknown, fallback: string[] = []) => Array.isArray(value) ? value.filter(item => typeof item === "string") : fallback
    return { ...defaults, ...saved, agent: typeof saved.agent === "string" ? saved.agent : defaults.agent, sort: ["recent", "name", "manual"].includes(saved.sort) ? saved.sort : "recent", draft: typeof saved.draft === "string" ? saved.draft : "", executables: saved.executables && typeof saved.executables === "object" ? Object.fromEntries(Object.entries(saved.executables).filter(([, value]) => typeof value === "string")) : {}, folderOrder: strings(saved.folderOrder), collapsed: strings(saved.collapsed), folders: strings(saved.folders, defaults.folders) }
  } catch { return defaults }
}
export function saveWorkspace(host: string, value: AgentWorkspacePreferences) {
  try { const all = JSON.parse(localStorage.getItem(key) || "{}"); localStorage.setItem(key, JSON.stringify({ ...all, [host]: value })) } catch { /* Session stays usable if browser storage is unavailable. */ }
}
