import type { Session } from "../types"
import { saveAgentWorkspace, storedWorkspace, storedWorkspaces } from "../session/agentStorage"

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
  submissionUnknown?: boolean
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
  drafts?: Record<string, string>
}
const key = "still.agents.workspace.v2"
export function readWorkspace(host: string, _initialFolder = ""): AgentWorkspacePreferences {
  const defaults: AgentWorkspacePreferences = { folder: "", agent: "opencode", sort: "recent", collapsed: [], folders: [], folderOrder: [], executables: {}, draft: "" }
  try {
    const saved = (storedWorkspace(host) ?? JSON.parse(localStorage.getItem(key) || "{}")[host]) as AgentWorkspacePreferences | undefined
    if (!saved || typeof saved.folder !== "string") return defaults
    const strings = (value: unknown, fallback: string[] = []) => Array.isArray(value) ? value.filter(item => typeof item === "string") : fallback
    return { ...defaults, ...saved, agent: typeof saved.agent === "string" ? saved.agent : defaults.agent, sort: ["recent", "name", "manual"].includes(saved.sort) ? saved.sort : "recent", draft: typeof saved.draft === "string" ? saved.draft : "", executables: saved.executables && typeof saved.executables === "object" ? Object.fromEntries(Object.entries(saved.executables).filter(([, value]) => typeof value === "string")) : {}, folderOrder: strings(saved.folderOrder), collapsed: strings(saved.collapsed), folders: strings(saved.folders, defaults.folders) }
  } catch { return defaults }
}
export function saveWorkspace(host: string, value: AgentWorkspacePreferences) {
  saveAgentWorkspace(host, value)
}

export interface AgentProject { host: string; folder: string; name?: string }
export const projectKey = (project: AgentProject) => JSON.stringify([project.host, project.folder])
export function hostLabel(key: string) {
  try { const [host, port, username] = JSON.parse(key); return `${username}@${host}${port === 22 ? "" : `:${port}`}` } catch { return "Unassigned server" }
}
export function sessionForHost(key: string, sessions: Session[]): Session | null {
  const saved = sessions.find(session => hostKey(session) === key)
  if (saved) return saved
  try {
    const [host, port, username] = JSON.parse(key)
    if (typeof host !== "string" || typeof username !== "string" || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { id: `server:${key}`, name: host, host, port, username, projectId: "", workingDirectory: "", authMethod: "ask", remember: false, tmuxSession: "", createdAt: 0, updatedAt: 0 }
  } catch { return null }
}
export interface AgentLibraryPreferences {
  projects: AgentProject[]
  sort: "recent" | "name" | "manual"
  collapsed: string[]
  drafts: Record<string, string>
  agent: string
  executables: Record<string, Record<string, string>>
  servers: Session[]
}
export function readLibraryPreferences(): AgentLibraryPreferences {
  const defaults: AgentLibraryPreferences = { projects: [], sort: "recent", collapsed: [], drafts: {}, agent: "opencode", executables: {}, servers: [] }
  const saved = storedWorkspace("library") as Partial<AgentLibraryPreferences> | undefined
  if (saved) {
    const strings = (value: unknown): Record<string, string> => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, text]) => typeof text === "string")) : {}
    return { ...defaults, projects: Array.isArray(saved.projects) ? saved.projects.filter(p => p && typeof p.host === "string" && typeof p.folder === "string").map(p => ({ ...p, name: typeof p.name === "string" ? p.name : undefined })) : [],
      sort: ["recent", "name", "manual"].includes(saved.sort || "") ? saved.sort! : "recent", collapsed: Array.isArray(saved.collapsed) ? saved.collapsed.filter(value => typeof value === "string") : [],
      agent: typeof saved.agent === "string" ? saved.agent : "opencode", drafts: strings(saved.drafts), executables: saved.executables && typeof saved.executables === "object" ? Object.fromEntries(Object.entries(saved.executables).map(([key, paths]) => [key, strings(paths)])) : {}, servers: Array.isArray(saved.servers) ? saved.servers.filter(server => server && typeof server.host === "string" && typeof server.username === "string" && typeof server.port === "number").map(agentServerProfile) : [] }
  }
  for (const host of Object.keys(storedWorkspaces())) {
    const prefs = readWorkspace(host)
    const folders = prefs.sort === "manual" ? [...new Set([...prefs.folderOrder.filter(folder => prefs.folders.includes(folder)), ...prefs.folders])] : prefs.folders
    if (prefs.sort === "manual") defaults.sort = "manual"
    for (const folder of folders) defaults.projects.push({ host, folder })
    if (prefs.draft) defaults.drafts[projectKey({ host, folder: prefs.folder })] = prefs.draft
    defaults.collapsed.push(...prefs.collapsed.map(folder => projectKey({ host, folder })))
    defaults.executables[host] = prefs.executables
  }
  return defaults
}

/** Explicit metadata allowlist: never persist the transient connection answer. */
export function agentServerProfile(server: Session): Session {
  return { id: server.id, name: server.name || server.host, host: server.host, port: server.port, username: server.username, authMethod: ["key", "password", "ask"].includes(server.authMethod) ? server.authMethod : "ask", keyId: server.keyId, remember: !!server.remember, projectId: "", workingDirectory: "", tmuxSession: "", createdAt: server.createdAt || Date.now(), updatedAt: server.updatedAt || Date.now() }
}
