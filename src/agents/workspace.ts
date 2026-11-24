import type { Session } from "../types"
import type { AgentDraftAttachment } from "./attachments"
import { saveAgentWorkspace, storedWorkspace, storedWorkspaces } from "../session/agentStorage"
import { sessionHostKey } from "../session/identity"
import type { CustomAgent, SharedConversation, SharedOperation, SharedProject } from "./types"
import { isCustomAgent } from "./customAgents"
import { folderName, normalizeFolder, projectKey } from "./projectIdentity"
export { folderName, normalizeFolder, projectKey }

export const hostKey = (session: Pick<Session, "host" | "port" | "username"> & Partial<Pick<Session, "transport">>) => sessionHostKey(session)
export const agentConnectionId = (session: Session) => `agents:${hostKey(session)}`
export interface ConversationMeta {
  id: string
  hostKey: string
  folder: string
  title: string
  titleSource?: "prompt" | "agent" | "user"
  pinned: boolean
  archivedAt?: number
  createdAt: number
  activityAt: number
  order: number
  draft: string
  draftAttachments?: AgentDraftAttachment[]
  submissionUnknown?: boolean
  prepared?: boolean
  parentConversationId?: string
  subagentOperations?: Record<string, string>
  subagentGuidance?: Array<{ requestId: string; messageId: string; text: string }>
  subagentGuidancePaused?: boolean
  subagentPrepared?: boolean
  shared?: SharedConversation
  sharedPending?: SharedOperation[]
  sharedSyncError?: string
  sharedConflict?: boolean
  sharedDeleted?: boolean
  sharedLocalChanges?: Partial<SharedConversation["values"]>
  sharedAdoptionResolved?: boolean
  migrationBlocked?: MigrationBlocked
}
export type MigrationBlockReason = "PendingMessage" | "RecoveryRequired" | "UnconfirmedState" | "GenerationNotNewer" | "LineageUnproven" | "ProviderSessionChanged" | "DifferentAccount"
export interface MigrationBlocked { reason: MigrationBlockReason; remoteExecutionId: string; remoteGeneration: number; detectedAt: number }
export const adoptableMigrationReasons: readonly MigrationBlockReason[] = ["PendingMessage", "RecoveryRequired", "UnconfirmedState"]
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
  draftAttachments?: AgentDraftAttachment[]
}
const key = "still.agents.workspace.v2"
export function readWorkspace(host: string, _initialFolder = ""): AgentWorkspacePreferences {
  const defaults: AgentWorkspacePreferences = { folder: "", agent: "opencode", sort: "recent", collapsed: [], folders: [], folderOrder: [], executables: {}, draft: "" }
  try {
    const saved = (storedWorkspace(host) ?? JSON.parse(localStorage.getItem(key) || "{}")[host]) as AgentWorkspacePreferences | undefined
    if (!saved || typeof saved.folder !== "string") return defaults
    const strings = (value: unknown, fallback: string[] = []) => Array.isArray(value) ? value.filter(item => typeof item === "string") : fallback
    return { ...defaults, ...saved, agent: typeof saved.agent === "string" ? saved.agent : defaults.agent, sort: ["recent", "name", "manual"].includes(saved.sort) ? saved.sort : "recent", draft: typeof saved.draft === "string" ? saved.draft : "", draftAttachments: Array.isArray(saved.draftAttachments) ? saved.draftAttachments.filter(item => item && typeof item.id === "string") : [], executables: saved.executables && typeof saved.executables === "object" ? Object.fromEntries(Object.entries(saved.executables).filter(([, value]) => typeof value === "string")) : {}, folderOrder: strings(saved.folderOrder), collapsed: strings(saved.collapsed), folders: strings(saved.folders, defaults.folders) }
  } catch { return defaults }
}
export function saveWorkspace(host: string, value: AgentWorkspacePreferences) {
  saveAgentWorkspace(host, value)
}

export interface AgentProject { host: string; folder: string; name?: string }
export interface SharedAccountCache { serverAccountId: string; revision: number; projects: SharedProject[] }
export function sharedAccount(host: string): SharedAccountCache | undefined {
  return storedWorkspace(`shared-account:${host}`) as SharedAccountCache | undefined
}
export function sharedProjectNameDraft(project: AgentProject): { title: string; conflict: boolean } | undefined {
  const account = sharedAccount(project.host), remote = account?.projects.find(item => item.cwd === project.folder)
  if (!account || !remote) return
  const pending = storedWorkspace(`shared-project-intent:${account.serverAccountId}:${remote.id}`) as { input?: SharedOperation; conflict?: boolean } | undefined
  return typeof pending?.input?.patch?.name === "string" ? { title: pending.input.patch.name, conflict: pending.conflict === true } : undefined
}
export function sharedProjectDeleted(project: AgentProject) {
  return sharedAccount(project.host)?.projects.find(item => item.cwd === project.folder)?.deleted === true
}
export function sharedProjects(): AgentProject[] {
  return Object.entries(storedWorkspaces()).flatMap(([key, value]) => {
    if (!key.startsWith("shared-account:") || !value || typeof value !== "object") return []
    const cache = value as SharedAccountCache
    if (!Array.isArray(cache.projects)) return []
    const host = key.slice("shared-account:".length)
    const saved = (storedWorkspace("library") as Partial<AgentLibraryPreferences> | undefined)?.projects || []
    return [...cache.projects].filter(project => !project.deleted).sort((a, b) => b.order - a.order).map(project => {
      const pending = storedWorkspace(`shared-project-intent:${cache.serverAccountId}:${project.id}`) as { input?: SharedOperation; conflict?: boolean } | undefined
      const intended = !pending?.conflict && typeof pending?.input?.patch?.name === "string" ? pending.input.patch.name : undefined
      return { host, folder: project.cwd, name: intended ?? (project.name || saved.find(local => local.host === host && local.folder === project.cwd)?.name || undefined) }
    })
  })
}
export function orderSharedProjects(projects: AgentProject[]): AgentProject[] {
  const byHost = new Map<string, AgentProject[]>()
  for (const project of projects) {
    const account = sharedAccount(project.host)
    if (!account) continue
    const group = byHost.get(project.host) || []
    group.push(project); byHost.set(project.host, group)
  }
  for (const [host, group] of byHost) {
    const account = sharedAccount(host)!
    const pending = storedWorkspace(`shared-project-order:${account.serverAccountId}`) as { input?: SharedOperation; conflict?: boolean } | undefined
    const intended = !pending?.conflict ? pending?.input?.order : undefined
    const orders = new Map(account.projects.map(project => [project.cwd, intended ? (intended.length - intended.findIndex(item => item.id === project.id)) * 1024 : project.order]))
    group.sort((a, b) => (orders.get(b.folder) || 0) - (orders.get(a.folder) || 0))
  }
  const cursors = new Map<string, number>()
  return projects.map(project => {
    const group = byHost.get(project.host)
    if (!group) return project
    const cursor = cursors.get(project.host) || 0
    cursors.set(project.host, cursor + 1)
    return group[cursor]
  })
}
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
  sidebarCollapsed: boolean
  sort: "recent" | "name" | "manual"
  collapsed: string[]
  drafts: Record<string, string>
  draftAttachments: Record<string, AgentDraftAttachment[]>
  agent: string
  executables: Record<string, Record<string, string>>
  customAgents: Record<string, CustomAgent[]>
  servers: Session[]
}
export function readLibraryPreferences(): AgentLibraryPreferences {
  const defaults: AgentLibraryPreferences = { projects: [], sidebarCollapsed: false, sort: "recent", collapsed: [], drafts: {}, draftAttachments: {}, agent: "opencode", executables: {}, customAgents: {}, servers: [] }
  const saved = storedWorkspace("library") as Partial<AgentLibraryPreferences> | undefined
  if (saved) {
    const strings = (value: unknown): Record<string, string> => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, text]) => typeof text === "string")) : {}
    return { ...defaults, sidebarCollapsed: saved.sidebarCollapsed === true, projects: Array.isArray(saved.projects) ? saved.projects.filter(p => p && typeof p.host === "string" && typeof p.folder === "string").map(p => ({ ...p, name: typeof p.name === "string" ? p.name : undefined })) : [],
      sort: ["recent", "name", "manual"].includes(saved.sort || "") ? saved.sort! : "recent", collapsed: Array.isArray(saved.collapsed) ? saved.collapsed.filter(value => typeof value === "string") : [],
      agent: typeof saved.agent === "string" ? saved.agent : "opencode", customAgents: saved.customAgents && typeof saved.customAgents === "object" ? Object.fromEntries(Object.entries(saved.customAgents).map(([host, agents]) => [host, Array.isArray(agents) ? agents.filter((agent): agent is CustomAgent => isCustomAgent(agent, host)) : []])) : {}, drafts: strings(saved.drafts), draftAttachments: saved.draftAttachments && typeof saved.draftAttachments === "object" ? Object.fromEntries(Object.entries(saved.draftAttachments).map(([key, list]) => [key, Array.isArray(list) ? list.filter(item => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.hostKey === "string" && typeof item.folder === "string") : []])) : {}, executables: saved.executables && typeof saved.executables === "object" ? Object.fromEntries(Object.entries(saved.executables).map(([key, paths]) => [key, strings(paths)])) : {}, servers: Array.isArray(saved.servers) ? saved.servers.filter(server => server && typeof server.host === "string" && typeof server.username === "string" && typeof server.port === "number").map(agentServerProfile) : [] }
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
