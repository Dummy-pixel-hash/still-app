import { folderName, projectKey } from "../agents/projectIdentity"
import type { AgentProject } from "../agents/workspace"
import type { AgentThreadRow } from "../session/agentThreads"
import { sessionHostKey } from "../session/identity"
import type { Session } from "../types"
import { needsAttention } from "./threads"

export const MOBILE_LIBRARY_KEY = "mobile-thread-library-v1"
export interface MobileLibraryPreferences { project: string; sort: "recent" | "name"; collapsed: string[] }
export function mobileLibraryPreferences(value: unknown): MobileLibraryPreferences {
  const saved = value && typeof value === "object" ? value as Partial<MobileLibraryPreferences> : {}
  return { project: typeof saved.project === "string" && saved.project.length <= 8192 ? saved.project || "all" : "all",
    sort: saved.sort === "name" ? "name" : "recent",
    collapsed: Array.isArray(saved.collapsed) ? [...new Set(saved.collapsed.filter((key): key is string => typeof key === "string" && key.length <= 8192))].slice(0, 512) : [] }
}
export function threadActivity(row: AgentThreadRow) {
  const value = row.meta.activityAt
  return Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : 0
}
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
const stable = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function accountLabel(host: string) {
  try { const [address, port, username] = JSON.parse(host); return `${username}@${address}${port === 22 ? "" : `:${port}`}` }
  catch { return "Unassigned server" }
}
export interface MobileProjectGroup {
  key: string
  project: AgentProject
  label: string
  serverLabel: string
  accountLabel: string
  rows: AgentThreadRow[]
  activity: number
  attention: number
}

/** View-only ordering. This never changes conversation metadata or remote order. */
export function mobileProjectLibrary(rows: AgentThreadRow[], projects: AgentProject[], servers: Session[],
  options: { project: string; sort: "recent" | "name"; attentionOnly: boolean; query: string }) {
  const serverNames = new Map(servers.map(server => [sessionHostKey(server), server.name || server.host]))
  const duplicateServerNames = new Map<string, number>()
  for (const value of serverNames.values()) duplicateServerNames.set(value, (duplicateServerNames.get(value) || 0) + 1)
  const buckets = new Map<string, MobileProjectGroup>()
  for (const project of [...projects, ...rows.map(row => ({ host: row.meta.hostKey, folder: row.meta.folder }))]) {
    const key = projectKey(project)
    if (buckets.has(key)) continue
    const fallback = project.folder === "~" ? "Home folder" : project.folder === "/" ? "Root folder" : folderName(project.folder) || "Unassigned project"
    const label = "name" in project && typeof project.name === "string" && project.name.trim() ? project.name : fallback
    const server = serverNames.get(project.host)
    buckets.set(key, { key, project, label, serverLabel: server && duplicateServerNames.get(server) === 1 ? server : accountLabel(project.host),
      accountLabel: accountLabel(project.host), rows: [], activity: 0, attention: 0 })
  }
  const attentionById = new Map<string, boolean>()
  for (const row of rows) {
    const bucket = buckets.get(projectKey({ host: row.meta.hostKey, folder: row.meta.folder }))!
    const attention = needsAttention(row)
    attentionById.set(row.executionId, attention)
    bucket.rows.push(row); bucket.activity = Math.max(bucket.activity, threadActivity(row)); bucket.attention += Number(attention)
  }
  const byName = (a: MobileProjectGroup, b: MobileProjectGroup) => names.compare(a.label, b.label)
    || names.compare(a.serverLabel, b.serverLabel) || stable(a.project.folder, b.project.folder) || stable(a.key, b.key)
  const orderedProjects = [...buckets.values()].sort((a, b) => options.sort === "name" ? byName(a, b) : b.activity - a.activity || byName(a, b))
  const query = options.query.trim().toLocaleLowerCase()
  const active = buckets.get(options.project)
  const groups: MobileProjectGroup[] = []
  let scopedAttention = 0
  for (const bucket of orderedProjects) {
    if (options.project !== "all" && bucket.key !== options.project) continue
    const matching = bucket.rows.filter(row => !query || `${row.meta.title} ${row.transcript.find(event => event.type === "userMessage")?.text?.split("\n")[0].slice(0, 160) || ""} ${row.agentName} ${bucket.label} ${bucket.serverLabel} ${bucket.accountLabel} ${bucket.project.folder}`.toLocaleLowerCase().includes(query))
    scopedAttention += matching.filter(row => attentionById.get(row.executionId)).length
    const visible = matching.filter(row => !options.attentionOnly || attentionById.get(row.executionId))
      .sort((a, b) => Number(b.meta.pinned === true) - Number(a.meta.pinned === true) || threadActivity(b) - threadActivity(a) || stable(a.meta.id, b.meta.id))
    if (visible.length) groups.push({ ...bucket, rows: visible, attention: visible.filter(row => attentionById.get(row.executionId)).length })
  }
  return { projects: orderedProjects, groups, activeProject: active?.project || null, attention: scopedAttention,
    totalAttention: [...attentionById.values()].filter(Boolean).length, attentionById,
    resultCount: groups.reduce((sum, group) => sum + group.rows.length, 0) }
}
