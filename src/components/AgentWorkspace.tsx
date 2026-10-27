/* Device-owned conversations, explicit projects, quiet controls, reader-owned scrolling. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AGENTS, type AgentAvailability, type AgentCatalog, type AgentCommand, type AgentLaunchOptions } from "../agents/types"
import { conversation } from "../agents/transcript"
import { agentServerProfile, folderName, hostKey, hostLabel, normalizeFolder, projectKey, readLibraryPreferences, sessionForHost, type AgentLibraryPreferences, type AgentProject } from "../agents/workspace"
import { useConversationScroll } from "../agents/useConversationScroll"
import { useAgentListMotion } from "../agents/useAgentListMotion"
import { commandInventory } from "../agents/commands"
import { canResumeAgentThread, cancelAgentTurn, claimAgentThreads, clearAgentDraft, deleteAgentThread, loadAgentThreads, refreshAgentCommands, refreshAgentThread, respondAgentPermission, resumeAgentThread, sendAgentMessage, setAgentConfig, subscribeRemoteAgent, threadTitle, updateThreadMeta, useAgentThreads, type AgentThreadRow } from "../session/agentThreads"
import { discoverAgents, useAgentDiscovery } from "../session/agentDiscovery"
import { flushAgentSaves, saveAgentWorkspace, useAgentStorage } from "../session/agentStorage"
import { nativeBridge } from "../bridge/nativeBridge"
import type { Session } from "../types"
import AgentIcon from "./AgentIcon"
import AgentMenu from "./AgentMenu"
import { CommandPicker, ConfigPicker } from "./AgentControls"
import { AgentTimeline, InputCard, PermissionCard } from "./AgentTimeline"
import "../styles/agent-workspace.css"

type Props = {
  session: Session | null
  sessions?: Session[]
  onSelectHost?: (session: Session | null) => void
  onConnect?: () => Promise<void>
  connected?: boolean
  connectionNotice?: React.ReactNode
  onClose: () => void
  onOpenTerminal?: () => void
  onStart: (agentId: string, options?: AgentLaunchOptions, onCreated?: (row: AgentThreadRow) => void) => Promise<AgentThreadRow>
  onCheck: (agentId?: string, executable?: string) => Promise<AgentAvailability[]>
  onCatalog?: (agentId: string, cwd: string, executable?: string) => Promise<AgentCatalog>
  onResolveFolder?: (cwd: string) => Promise<string>
}
const messageOf = (e: unknown) => e && typeof e === "object" && "message" in e ? String(e.message) : String(e || "Operation failed")
const idle = (row: AgentThreadRow | null) => !!row && !row.turnActive && !row.pendingPermission && !row.pendingInput && ["working", "complete", "cancelled"].includes(row.state)
const statusOf = (row: AgentThreadRow) => row.pendingPermission || row.pendingInput ? "Needs you" : row.state === "saved" ? "Saved" : row.state === "connecting" ? "Connecting" : row.turnActive ? "Working" : row.state === "submissionUnknown" ? "Uncertain" : row.state === "error" ? "Failed" : "Ready"
const catalogs = new Map<string, AgentCatalog>()
const pendingCatalogs = new Map<string, Promise<AgentCatalog>>()
function loadCatalog(key: string, read: () => Promise<AgentCatalog>) {
  const pending = pendingCatalogs.get(key)
  if (pending) return pending
  const task = read().finally(() => pendingCatalogs.delete(key))
  pendingCatalogs.set(key, task)
  return task
}
const historyWindows = new Map<string, string>()

export default function AgentWorkspace({ session, sessions = [], onSelectHost, onConnect, connected = true, connectionNotice, onClose, onOpenTerminal, onStart, onCheck, onCatalog, onResolveFolder }: Props) {
  const allThreads = useAgentThreads(), storage = useAgentStorage()
  const [prefs, setPrefs] = useState<AgentLibraryPreferences>(() => readLibraryPreferences())
  const [hydrated, setHydrated] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [project, setProject] = useState<AgentProject | null>(null)
  const [view, setView] = useState<"home" | "draft" | "project" | "settings">("home")
  const [sidebar, setSidebar] = useState(false), [query, setQuery] = useState(""), [archived, setArchived] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const [rename, setRename] = useState<{ id: string; title: string; project?: AgentProject } | null>(null)
  const [deleting, setDeleting] = useState<AgentThreadRow | null>(null)
  const [undo, setUndo] = useState<{ id: string; at?: number } | null>(null)
  const [busy, setBusy] = useState(false), [configBusy, setConfigBusy] = useState(false)
  const [error, setError] = useState(""), [advanced, setAdvanced] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false), [commandQuery, setCommandQuery] = useState("")
  const [timelineOpen, setTimelineOpen] = useState(false), [timelineQuery, setTimelineQuery] = useState("")
  const [feedback, setFeedback] = useState("")
  const [folderOpen, setFolderOpen] = useState(false), [folderHost, setFolderHost] = useState(""), [folderPath, setFolderPath] = useState("")
  const [projectChoices, setProjectChoices] = useState(false)
  const [addingServer, setAddingServer] = useState(false)
  const [catalog, setCatalog] = useState<AgentCatalog>({ commands: [], configOptions: [] })
  const [catalogBusy, setCatalogBusy] = useState(false), [catalogError, setCatalogError] = useState(""), [catalogRefresh, setCatalogRefresh] = useState(0)
  const [draftConfig, setDraftConfig] = useState<Record<string, Record<string, string | boolean>>>({})
  const [, updateHistoryWindow] = useState(0)
  const surface = useRef<HTMLElement>(null), textarea = useRef<HTMLTextAreaElement>(null), search = useRef<HTMLInputElement>(null)
  const navigation = useRef(0), mounted = useRef(true), prefsRef = useRef(prefs)
  const folderOperation = useRef(0)
  const callbacks = useRef({ onCheck, onCatalog, onStart }); callbacks.current = { onCheck, onCatalog, onStart }; prefsRef.current = prefs
  const host = session ? hostKey(session) : ""
  const discovery = useAgentDiscovery(host)
  const current = allThreads.find(row => row.meta.id === selected) || null
  const context = current ? { host: current.meta.hostKey, folder: current.meta.folder } : project
  const contextKey = context ? projectKey(context) : "unassigned"
  const connectedHere = !!context && context.host === host && connected
  const agentId = current?.agentId || prefs.agent
  const definition = AGENTS.find(agent => agent.id === agentId) || AGENTS[0]
  const executable = context ? prefs.executables[context.host]?.[agentId]?.trim() || undefined : undefined
  const available = discovery.agents.find(agent => agent.agentId === agentId)
  const draftKey = project ? projectKey(project) : "unassigned"
  const configurationKey = JSON.stringify([contextKey, agentId, executable])
  const selectedConfig = draftConfig[configurationKey] || {}
  const draft = current ? current.meta.draft : prefs.drafts[draftKey] || ""
  const fields = current?.configOptions || catalog.configOptions.map(option => ({ ...option, currentValue: selectedConfig[option.id] ?? option.currentValue }))
  const items = useMemo(() => conversation(current?.transcript || []), [current?.transcript])
  const historyId = current?.meta.id || ""
  const historyStart = historyWindows.get(historyId)
  const firstItem = historyStart === undefined ? Math.max(0, items.length - 120) : historyStart === "" ? 0 : Math.max(0, items.findIndex(item => item.id === historyStart))
  const visibleItems = useMemo(() => items.slice(firstItem), [items, firstItem])
  useLayoutEffect(() => { if (historyId && !historyWindows.has(historyId)) historyWindows.set(historyId, items[firstItem]?.id || "") }, [historyId, items, firstItem])
  const plan = useMemo(() => current?.transcript.slice().reverse().find(event => event.type === "plan")?.plan, [current?.transcript])
  const scroll = useConversationScroll(current?.meta.id || `${view}:${contextKey}`, current?.transcript)
  const showComposer = view === "draft" || !!current
  const canSend = hydrated && connectedHere && !busy && !configBusy && !!draft.trim() && (current ? idle(current) && !current.meta.archivedAt : available?.available === true && !discovery.checking)
  const threads = allThreads.filter(row => !!row.meta.archivedAt === archived && (!query || `${threadTitle(row)} ${row.meta.folder} ${hostLabel(row.meta.hostKey)} ${row.agentName}`.toLowerCase().includes(query.toLowerCase())))
  const projects = [...prefs.projects]
  for (const row of allThreads) if (!projects.some(p => p.host === row.meta.hostKey && p.folder === row.meta.folder)) projects.push({ host: row.meta.hostKey, folder: row.meta.folder })
  const activity = (p: AgentProject) => Math.max(0, ...allThreads.filter(row => row.meta.hostKey === p.host && row.meta.folder === p.folder).map(row => row.meta.activityAt))
  const sortedProjects = projects.filter(p => !query || threads.some(row => row.meta.hostKey === p.host && row.meta.folder === p.folder)).sort((a, b) => prefs.sort === "name" ? (a.name || folderName(a.folder)).localeCompare(b.name || folderName(b.folder)) : prefs.sort === "recent" ? activity(b) - activity(a) : 0)
  const listMotion = useAgentListMotion(JSON.stringify([sortedProjects.map(projectKey), prefs.collapsed, prefs.sort, threads.map(row => [row.meta.id, row.meta.order, row.meta.pinned, row.meta.activityAt])]))
  const knownServers = [...prefs.servers, ...sessions, ...(session ? [session] : [])]
  const hosts = [...new Map([...projects.map(p => sessionForHost(p.host, knownServers)).filter((s): s is Session => !!s), ...knownServers].map(s => [hostKey(s), s])).values()]
  const providerCommands = current?.commands || catalog.commands
  const commands = commandInventory(providerCommands, agentId)

  const hydrate = () => loadAgentThreads().then(() => { if (mounted.current) { setPrefs(readLibraryPreferences()); setHydrated(true) } }).catch(e => setError(messageOf(e)))
  useEffect(() => { void hydrate() }, [])
  useEffect(() => { if (hydrated) saveAgentWorkspace("library", prefs) }, [prefs, hydrated])
  useEffect(() => {
    if (!hydrated || !session) return
    const profile = agentServerProfile(session)
    setPrefs(old => ({ ...old, servers: [...old.servers.filter(server => hostKey(server) !== host), profile] }))
  }, [hydrated, host, session?.authMethod, session?.keyId])
  useEffect(() => { for (const server of hosts) claimAgentThreads(server, sessions.filter(s => hostKey(s) === hostKey(server)).map(s => s.id)) }, [hydrated, allThreads.length, sessions])
  useEffect(() => {
    if (!host || !connected) return
    void discoverAgents(host, () => {
      const paths = prefsRef.current.executables[host] || {}
      return Object.values(paths).some(Boolean) ? Promise.all(AGENTS.map(agent => callbacks.current.onCheck(agent.id, paths[agent.id]))).then(rows => rows.flat()) : callbacks.current.onCheck()
    })
  }, [host, connected])
  useEffect(() => {
    setCatalogError("")
    if (current || !context || !connectedHere || !onCatalog || agentId !== "opencode") { setCatalog({ commands: [], configOptions: [] }); setCatalogBusy(false); return }
    let cancelled = false
    const key = JSON.stringify([context.host, context.folder, agentId, executable])
    setCatalog(catalogs.get(key) || { commands: [], configOptions: [] }); setCatalogBusy(true)
    void loadCatalog(key, () => callbacks.current.onCatalog!(agentId, context.folder, executable)).then(value => { catalogs.set(key, value); if (!cancelled) { setCatalog(value); setCatalogError(value.warning || "") } }).catch(e => { if (!cancelled) setCatalogError(messageOf(e)) }).finally(() => { if (!cancelled) setCatalogBusy(false) })
    return () => { cancelled = true }
  }, [contextKey, connectedHere, agentId, executable, catalogRefresh, !!current])
  useEffect(() => { if (current) void subscribeRemoteAgent(current.executionId); setError(""); setMenu(null); setAdvanced(false); setCommandOpen(false) }, [selected, current?.executionId])
  useEffect(() => { const input = textarea.current; if (input) { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 156)}px` } }, [draft, selected, view])
  useEffect(() => { mounted.current = true; const previous = document.activeElement as HTMLElement | null; surface.current?.focus(); return () => { mounted.current = false; void flushAgentSaves(); if (previous?.isConnected) previous.focus() } }, [])
  useEffect(() => {
    if (!folderOpen && !deleting && !timelineOpen) return
    const previous = document.activeElement as HTMLElement | null
    surface.current?.querySelector<HTMLElement>(".agent-modal :is(input,select,button)")?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [folderOpen, !!deleting, timelineOpen])

  const setDraft = (text: string) => current ? updateThreadMeta(current.executionId, { draft: text }) : setPrefs(old => ({ ...old, drafts: { ...old.drafts, [draftKey]: text } }))
  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation() } catch (e) { setError(messageOf(e)) } finally { if (mounted.current) setBusy(false) } }
  const selectHost = (key: string) => { const server = sessionForHost(key, hosts); if (server) onSelectHost?.(server) }
  const home = () => { navigation.current++; setSelected(null); setProject(null); setView("home"); setCommandOpen(false); setMenu(null); setAdvanced(false); setProjectChoices(false); setSidebar(false); setError("") }
  const openProject = (p: AgentProject) => { navigation.current++; setSelected(null); setProject(p); setView("project"); setCommandOpen(false); setMenu(null); setSidebar(false); setError(""); selectHost(p.host) }
  const newThread = (p: AgentProject | null = null) => { navigation.current++; setSelected(null); setProject(p); setView("draft"); setArchived(false); setCommandOpen(false); setMenu(null); setProjectChoices(false); setSidebar(false); setAdvanced(false); setError(""); if (p) selectHost(p.host); requestAnimationFrame(() => { if (!surface.current?.querySelector(".agent-command-menu")) textarea.current?.focus() }) }
  const assignProject = (p: AgentProject) => {
    if (view === "draft" && !current && !project && prefsRef.current.drafts.unassigned) {
      const key = projectKey(p)
      if (!prefsRef.current.drafts[key]) setPrefs(old => ({ ...old, drafts: { ...old.drafts, [key]: old.drafts.unassigned, unassigned: "" } }))
      else setFeedback("This project has a draft. Your unassigned idea is kept in New conversation.")
    }
    newThread(p)
  }
  const selectThread = (row: AgentThreadRow) => { navigation.current++; setSelected(row.meta.id); setProject({ host: row.meta.hostKey, folder: row.meta.folder }); setView("draft"); setSidebar(false); if (row.state !== "saved" && row.state !== "submissionUnknown") selectHost(row.meta.hostKey) }
  const closeFolder = () => { folderOperation.current++; setFolderOpen(false) }
  const chooseFolder = () => { folderOperation.current++; setFolderOpen(true); const key = context?.host || host; setFolderHost(key); if (key && key !== host) selectHost(key); setFolderPath(""); setError(""); setAddingServer(false) }
  const openFolder = async () => {
    if (!folderHost || !folderPath.trim() || !connected || folderHost !== host) return
    const operation = folderOperation.current
    await run(async () => {
      const folder = onResolveFolder ? await onResolveFolder(folderPath.trim()) : normalizeFolder(folderPath.trim())
      if (!mounted.current || operation !== folderOperation.current) return
      const p = { host: folderHost, folder }
      setPrefs(old => ({ ...old, projects: old.projects.some(item => projectKey(item) === projectKey(p)) ? old.projects : [...old.projects, p] }))
      closeFolder(); assignProject(p)
    })
  }
  const start = async () => {
    if (!context || !connectedHere) throw new Error("Choose a project and connect its server first.")
    const revision = navigation.current, launch = { ...context }, agent = agentId, initial = draft, settings = { ...selectedConfig }
    let createdId = ""
    const created = (row: AgentThreadRow) => {
      if (createdId) return
      createdId = row.executionId
      const resolved = { host: launch.host, folder: normalizeFolder(row.cwd) }
      const latest = navigation.current === revision ? prefsRef.current.drafts[draftKey] ?? initial : initial
      updateThreadMeta(row.executionId, { hostKey: resolved.host, folder: resolved.folder, draft: latest })
      if (mounted.current && navigation.current === revision) {
        setSelected(row.meta.id); setProject(resolved); setView("draft"); setAdvanced(false)
        setPrefs(old => ({ ...old, drafts: { ...old.drafts, [draftKey]: "" }, projects: old.projects.some(p => projectKey(p) === projectKey(resolved)) ? old.projects : [...old.projects, resolved] }))
      }
    }
    const row = await callbacks.current.onStart(agent, { cwd: launch.folder, executable }, created)
    created(row)
    for (const [id, value] of Object.entries(settings)) await setAgentConfig(row.executionId, id, value)
    return row
  }
  const chooseCommand = (command: AgentCommand, argument?: string) => {
    if (command.unavailable) { setCatalogError(command.unavailable); setCommandOpen(true); return }
    if (command.route !== "client") { setDraft(command.route === "skill" ? `@${command.name.replace(/^skill:/, "")} ` : `/${command.name} `); setCommandOpen(false); textarea.current?.focus(); return }
    setCommandOpen(false)
    if (command.name === "new") newThread(context)
    else if (command.name === "open") chooseFolder()
    else if (command.name === "sessions") { setSidebar(true); search.current?.focus() }
    else if (command.name === "settings") setAdvanced(true)
    else if (command.name === "help") { setCommandQuery(""); setCommandOpen(true) }
    else if (command.name === "skills") { setCommandQuery("skill:"); setCommandOpen(true) }
    else if (command.name === "rename") {
      if (!current) { setError("Open a conversation to rename it."); return }
      if (argument?.trim()) updateThreadMeta(current.executionId, { title: argument.trim() })
      else { setSidebar(true); setRename({ id: current.executionId, title: threadTitle(current) }) }
    }
    else if (command.name === "copy") {
      if (!current) { setError("Open a saved conversation to copy it."); return }
      const markdown = `# ${threadTitle(current)}\n\n` + items.filter(item => ["user", "assistant", "reasoning"].includes(item.kind)).map(item => `## ${item.kind === "user" ? "You" : item.kind === "reasoning" ? "Reasoning" : current.agentName}\n\n${item.text}`).join("\n\n")
      void nativeBridge.clipboardWriteText(markdown).then(() => setFeedback("Conversation copied")).catch(e => setError(messageOf(e)))
    }
    else if (command.name === "timeline") { if (current) { setTimelineQuery(""); setTimelineOpen(true) } else setError("Open a conversation to find a message.") }
    else if (command.name === "providers") { if (current) setError("Choose a coding agent when starting a new conversation."); else surface.current?.querySelector<HTMLButtonElement>('[data-config-id="provider"] > button')?.click() }
    else {
      const category = command.name === "models" ? "model" : command.name === "variants" ? "thought_level" : "mode"
      const option = fields.find(option => option.category === category)
      if (!option) { setError(`Choose a project and connect ${definition.label} to load its ${category === "model" ? "models" : "modes"}.`); return }
      if (category !== "model") setAdvanced(true)
      requestAnimationFrame(() => surface.current?.querySelector<HTMLButtonElement>(`[data-config-id="${CSS.escape(option.id)}"] > button`)?.click())
    }
  }
  const send = async () => {
    const text = draft.trim(), parsed = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    const command = commands.find(c => c.name === parsed?.[1]) || commands.find(c => c.aliases?.includes(parsed?.[1] || ""))
    if (command?.route === "client" || command?.unavailable) { chooseCommand(command, parsed?.[2]); if (!command.unavailable) setDraft(""); return }
    if (!canSend) return
    const revision = navigation.current
    await run(async () => {
      const row = current || await start()
      if (!idle(row)) return
      await sendAgentMessage(row.executionId, text); clearAgentDraft(row.executionId, text)
      if (mounted.current && navigation.current === revision) scroll.anchorTurn(row.meta.id)
    })
  }
  const changeConfig = async (id: string, value: string | boolean) => {
    if (!current) { setDraftConfig(old => ({ ...old, [configurationKey]: { ...old[configurationKey], [id]: value } })); return }
    setConfigBusy(true); setError("")
    try { await setAgentConfig(current.executionId, id, value) } catch (e) { setError(messageOf(e)) } finally { setConfigBusy(false) }
  }
  const resume = async () => {
    if (!current) return
    const revision = navigation.current, target = current
    await run(async () => { const next = await resumeAgentThread(target.executionId, onStart, executable); if (mounted.current && navigation.current === revision) setSelected(next.meta.id) })
  }
  const archiveThread = (row: AgentThreadRow) => {
    setUndo({ id: row.executionId, at: row.meta.archivedAt }); updateThreadMeta(row.executionId, { archivedAt: row.meta.archivedAt ? undefined : Date.now() }); setMenu(null)
    if (selected === row.meta.id) home()
  }
  const moveThread = (row: AgentThreadRow, delta: number) => {
    const siblings = allThreads.filter(item => item.meta.hostKey === row.meta.hostKey && item.meta.folder === row.meta.folder).sort((a, b) => b.meta.order - a.meta.order)
    const other = siblings[siblings.indexOf(row) + delta]
    if (other) { const order = row.meta.order; updateThreadMeta(row.executionId, { order: other.meta.order }); updateThreadMeta(other.executionId, { order }); setPrefs(old => ({ ...old, sort: "manual" })) }
    setMenu(null)
  }
  const moveProject = (p: AgentProject, delta: number) => {
    const next = [...sortedProjects], index = next.findIndex(item => projectKey(item) === projectKey(p)), target = index + delta
    if (target >= 0 && target < next.length) { [next[index], next[target]] = [next[target], next[index]]; setPrefs(old => ({ ...old, projects: next, sort: "manual" })) }
    setMenu(null)
  }
  const finishRename = () => {
    if (!rename) return
    if (rename.project) setPrefs(old => ({ ...old, projects: projects.map(p => projectKey(p) === rename.id ? { ...p, name: rename.title.trim() || undefined } : p) }))
    else updateThreadMeta(rename.id, { title: rename.title.trim() })
    setRename(null)
  }
  const check = () => discoverAgents(host, () => Promise.all(AGENTS.map(agent => onCheck(agent.id, prefs.executables[host]?.[agent.id]?.trim() || undefined))).then(rows => rows.flat()))
  const refreshCatalog = async () => {
    if (!current) { setCatalogRefresh(value => value + 1); return }
    if (!connectedHere || !onCatalog || agentId !== "opencode") { setCatalogError("Connect this conversation's server to refresh its command inventory."); return }
    const id = current.executionId, revision = navigation.current
    setCatalogBusy(true); setCatalogError("")
    try {
      const next = await refreshAgentCommands(id, () => onCatalog(agentId, current.cwd, executable))
      if (navigation.current === revision) setCatalogError(next.warning || "")
    } catch (e) { if (navigation.current === revision) setCatalogError(messageOf(e)) }
    finally { setCatalogBusy(false) }
  }
  const loadEarlier = () => {
    scroll.preparePrepend()
    historyWindows.set(historyId, items[Math.max(0, firstItem - 120)]?.id || "")
    updateHistoryWindow(value => value + 1)
  }
  const findMessage = (id: string) => {
    const index = items.findIndex(item => item.id === id)
    if (index >= 0 && index < firstItem) { historyWindows.set(historyId, items[Math.max(0, index - 12)].id); updateHistoryWindow(value => value + 1) }
    setTimelineOpen(false)
    requestAnimationFrame(() => scroll.jumpTo(id))
  }
  const providerOption = { id: "provider", name: "Coding agent", category: "provider", type: "select", currentValue: prefs.agent, options: AGENTS.map(agent => {
    const found = discovery.agents.find(info => info.agentId === agent.id)
    return { value: agent.id, name: agent.label, description: found?.available ? "Installed on this server" : found?.installed ? found.message || "Integration unavailable" : found ? "Not installed on this server" : discovery.checking ? "Checking installation…" : "Not checked" }
  }) }
  const projectName = context ? projects.find(p => projectKey(p) === contextKey)?.name || folderName(context.folder) : ""
  const recent = threads.filter(row => view !== "project" || context && row.meta.hostKey === context.host && row.meta.folder === context.folder).sort((a, b) => Number(b.meta.pinned) - Number(a.meta.pinned) || b.meta.activityAt - a.meta.activityAt)

  return <section ref={surface} className="agent-workspace" tabIndex={-1} role="dialog" aria-modal="true" aria-label={session ? `Agents on ${session.name}` : "Agents workspace"}
    onPointerDown={e => { if (!(e.target as HTMLElement).closest(".agent-thread-menu,.agent-thread-more")) setMenu(null) }}
    onKeyDown={e => {
      e.stopPropagation()
      if (!folderOpen && !timelineOpen && !deleting && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); if (!showComposer) newThread(); setCommandQuery(""); setCommandOpen(true) }
      if (e.key === "Escape") { e.preventDefault(); if (deleting) setDeleting(null); else if (timelineOpen) setTimelineOpen(false); else if (folderOpen) closeFolder(); else if (rename) setRename(null); else if (projectChoices) setProjectChoices(false); else if (commandOpen) setCommandOpen(false); else if (advanced) setAdvanced(false); else if (menu) setMenu(null); else if (sidebar) setSidebar(false); else if (view === "settings") home(); else onClose() }
      if (e.key === "Tab") {
        const root = surface.current?.querySelector(".agent-modal") || surface.current
        const elements = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href]') || [])].filter(el => el.getClientRects().length)
        if (e.shiftKey && (document.activeElement === elements[0] || document.activeElement === surface.current)) { e.preventDefault(); elements.at(-1)?.focus() }
        else if (!e.shiftKey && document.activeElement === elements.at(-1)) { e.preventDefault(); elements[0]?.focus() }
      }
    }}>
    {sidebar && <button className="agent-sidebar-scrim" aria-label="Hide projects" onClick={() => setSidebar(false)} />}
    <aside className={`agent-sidebar ${sidebar ? "is-open" : ""}`} aria-label="Projects and conversations">
      <div className="agent-sidebar-top"><button className="agent-brand" onClick={home}>still<span> / agents</span></button><button className="agent-icon-button" aria-label="Back to workspace" title="Back to workspace" onClick={onClose}><AgentIcon name="panel" /></button></div>
      <button className="agent-new-conversation" aria-label="New conversation" onClick={() => newThread()} disabled={!hydrated}><AgentIcon name="plus" />New conversation</button>
      <label className="agent-sidebar-search"><AgentIcon name="search" size={15} /><input ref={search} aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="agent-project-heading"><span>{archived ? "Archived" : "Projects"}</span><select aria-label="Sort projects and conversations" value={prefs.sort} onChange={e => setPrefs(old => ({ ...old, sort: e.target.value as typeof old.sort }))}><option value="recent">Recent</option><option value="name">A–Z</option><option value="manual">Manual</option></select><button className="agent-icon-button" aria-label="Add project folder" title="Add project" onClick={chooseFolder}><AgentIcon name="plus" size={15} /></button></div>
      <nav ref={listMotion} className="agent-thread-list" aria-label="Conversations by folder">
        {sortedProjects.map(p => {
          const key = projectKey(p), collapsed = prefs.collapsed.includes(key) && !query
          const rows = threads.filter(row => row.meta.hostKey === p.host && row.meta.folder === p.folder).sort((a, b) => Number(b.meta.pinned) - Number(a.meta.pinned) || (prefs.sort === "name" ? threadTitle(a).localeCompare(threadTitle(b)) : prefs.sort === "manual" ? b.meta.order - a.meta.order : b.meta.activityAt - a.meta.activityAt))
          if (archived && !rows.length) return null
          return <div className="agent-folder" key={key}>
            <div className={`agent-folder-heading ${contextKey === key ? "is-current" : ""}`} data-agent-row={`project:${key}`}>
              <button className="agent-icon-button agent-folder-toggle" aria-label={`Toggle ${p.name || folderName(p.folder)} conversations`} aria-expanded={!collapsed} title={p.folder} onClick={() => setPrefs(old => ({ ...old, collapsed: collapsed ? old.collapsed.filter(id => id !== key) : [...old.collapsed, key] }))}><AgentIcon name="chevron" size={12} style={{ transform: collapsed ? "" : "rotate(90deg)" }} /></button>
              {rename?.id === key ? <form className="agent-rename" onSubmit={e => { e.preventDefault(); finishRename() }}><input autoFocus aria-label="Project name" value={rename.title} onChange={e => setRename({ ...rename, title: e.target.value })} onBlur={finishRename} /></form> : <button className="agent-project-open" title={`${hostLabel(p.host)} · ${p.folder}`} onClick={() => openProject(p)}><span>{p.name || folderName(p.folder)}</span><small>{hostLabel(p.host)}</small></button>}
              <button className="agent-icon-button agent-thread-more" aria-label={`Project actions for ${p.folder}`} aria-expanded={menu === key} onClick={() => setMenu(menu === key ? null : key)}><AgentIcon name="more" size={14} /></button>
              {menu === key && <AgentMenu root={surface.current}><button role="menuitem" onClick={() => { newThread(p); setMenu(null) }}>New conversation</button><button role="menuitem" onClick={() => { setRename({ id: key, title: p.name || folderName(p.folder), project: p }); setMenu(null) }}>Rename project</button><button role="menuitem" onClick={() => moveProject(p, -1)}>Move project up</button><button role="menuitem" onClick={() => moveProject(p, 1)}>Move project down</button><button role="menuitem" disabled={allThreads.some(row => row.meta.hostKey === p.host && row.meta.folder === p.folder)} onClick={() => { setPrefs(old => ({ ...old, projects: old.projects.filter(item => projectKey(item) !== key) })); setMenu(null); if (contextKey === key) home() }}>Remove empty folder</button></AgentMenu>}
            </div>
            {!collapsed && <div className="agent-folder-threads">{rows.map(row => <div key={row.meta.id} data-agent-row={row.meta.id} className={`agent-thread ${selected === row.meta.id ? "is-selected" : ""}`} onContextMenu={e => { e.preventDefault(); setMenu(row.executionId) }}>
              {rename?.id === row.executionId ? <form className="agent-rename" onSubmit={e => { e.preventDefault(); finishRename() }}><input autoFocus aria-label="Conversation name" value={rename.title} onChange={e => setRename({ ...rename, title: e.target.value })} onBlur={finishRename} /></form> : <button className="agent-thread-open" aria-current={selected === row.meta.id ? "page" : undefined} title={`${threadTitle(row)} · ${statusOf(row)}`} onClick={() => selectThread(row)}><span className={`agent-thread-indicator ${row.pendingPermission || row.pendingInput ? "attention" : row.turnActive ? "working" : ""}`}><AgentIcon name={row.meta.pinned ? "pin" : "chat"} size={14} /></span><span className="agent-thread-title">{threadTitle(row)}</span>{(row.pendingPermission || row.pendingInput) && <span className="agent-attention-label">Needs you</span>}</button>}
              <button className="agent-icon-button agent-thread-more" aria-label={`Actions for ${threadTitle(row)}`} aria-expanded={menu === row.executionId} onClick={() => setMenu(menu === row.executionId ? null : row.executionId)}><AgentIcon name="more" size={14} /></button>
              {menu === row.executionId && <AgentMenu root={surface.current}><button role="menuitem" onClick={() => { setRename({ id: row.executionId, title: threadTitle(row) }); setMenu(null) }}><AgentIcon name="edit" />Rename</button><button role="menuitem" onClick={() => { updateThreadMeta(row.executionId, { pinned: !row.meta.pinned }); setMenu(null) }}><AgentIcon name="pin" />{row.meta.pinned ? "Unpin" : "Pin"}</button><button role="menuitem" onClick={() => moveThread(row, -1)}>Move up</button><button role="menuitem" onClick={() => moveThread(row, 1)}>Move down</button><hr /><button role="menuitem" disabled={row.turnActive} onClick={() => archiveThread(row)}><AgentIcon name="archive" />{row.meta.archivedAt ? "Restore" : "Archive"}</button><button role="menuitem" className="is-destructive" onClick={() => { setDeleting(row); setMenu(null) }}><AgentIcon name="trash" />Delete</button></AgentMenu>}
            </div>)}<button className="agent-empty-folder" aria-label={`New conversation in ${p.folder}`} onClick={() => newThread(p)}><AgentIcon name={prefs.drafts[key] ? "edit" : "plus"} size={13} />{prefs.drafts[key] ? "Continue draft" : "New conversation"}</button></div>}
          </div>
        })}
        {!sortedProjects.length && <p className="agent-sidebar-empty">{query ? "No matching conversations." : archived ? "Your archived conversations appear here." : "Add a project to keep its conversations together."}</p>}
      </nav>
      <div className="agent-sidebar-footer"><button onClick={() => { setArchived(!archived); home() }} className={archived ? "is-active" : ""}><AgentIcon name="archive" />{archived ? "All conversations" : "Archived"}<span>{allThreads.filter(row => row.meta.archivedAt).length || ""}</span></button><button onClick={() => { setView("settings"); setSelected(null); setSidebar(false) }}><AgentIcon name="settings" />Agent settings</button><div className="agent-storage-status" title={storage.path}><span className={`agent-status-dot ${storage.error ? "attention" : "connected"}`} />{!hydrated ? "Opening local history…" : storage.error ? "Changes need saving" : storage.pending ? "Saving on this device…" : "Saved on this device"}</div></div>
    </aside>
    <main className="agent-main">
      <header className="agent-topbar" data-tauri-drag-region><div className="agent-breadcrumb"><button className="agent-icon-button agent-mobile-menu" aria-label="Toggle projects" aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><AgentIcon name="panel" /></button><button onClick={home}>Conversations</button>{context && <><AgentIcon name="chevron" size={12} /><button onClick={() => openProject(context)} title={`${hostLabel(context.host)} · ${context.folder}`}>{projectName}</button></>}{current && <><AgentIcon name="chevron" size={12} /><strong>{threadTitle(current)}</strong></>}{view === "settings" && <strong>Settings</strong>}</div>
        <div className="agent-topbar-actions">{current && <span className="agent-status" role="status"><span className={`agent-status-dot ${current.turnActive ? "working" : ""}`} />{statusOf(current)}</span>}{onOpenTerminal && (!context || context.host === host) && <button className="agent-icon-button" aria-label="Open terminal" title="Open terminal" onClick={onOpenTerminal}><AgentIcon name="terminal" /></button>}<button className="agent-icon-button" aria-label="Close agent workspace" title="Close agent workspace" onClick={onClose}><AgentIcon name="close" /></button></div>
      </header>
      {(storage.error || storage.warnings.length > 0) && <div className="agent-storage-notice" role="alert"><span>{storage.error || storage.warnings[0]}</span>{storage.error && <button className="agent-button" onClick={() => { if (!hydrated) void hydrate(); else void flushAgentSaves() }}>{hydrated ? "Retry saving" : "Retry opening history"}</button>}</div>}
      {view === "settings" ? <section className="agent-setup">
        <div className="agent-settings-heading"><h1>Agent settings</h1><p>Use the coding agents already installed on your server.</p></div>
        <label className="agent-field">Server<select aria-label="Settings server" value={host} onChange={e => selectHost(e.target.value)}><option value="">Choose a server</option>{hosts.map(s => <option key={hostKey(s)} value={hostKey(s)}>{s.name} · {s.username}@{s.host}</option>)}</select></label>
        {session && connectionNotice}
        <div className="agent-settings-list">{AGENTS.map(provider => {
          const info = discovery.agents.find(row => row.agentId === provider.id)
          return <details className="agent-provider-setting" key={provider.id}><summary><span className="agent-provider-logo">{provider.label.slice(0, 1)}</span><span><strong>{provider.label}</strong><small>{info?.installed ? info.available ? info.runtime === "acp" ? "Installed · ACP connection" : "Installed · native connection" : info.message || "Integration unavailable" : discovery.checking ? "Checking installation…" : info ? "Not found" : "Select a server to check"}</small></span><AgentIcon name="chevron" size={14} /></summary><div className="agent-provider-details"><p>{provider.note}</p><label className="agent-field">Executable path<input aria-label={`${provider.label} executable path`} disabled={!host} value={prefs.executables[host]?.[provider.id] || ""} placeholder={info?.executable || provider.executable} onChange={e => setPrefs(old => ({ ...old, executables: { ...old.executables, [host]: { ...old.executables[host], [provider.id]: e.target.value } } }))} /></label>{!info?.installed && <><span>Install on the server</span><code className="agent-install-command">{provider.installCommand}</code></>}<span>Sign in on the server</span><code className="agent-install-command">{provider.loginCommand}</code></div></details>
        })}</div>
        <div className="agent-inline-actions"><button className="agent-button" disabled={!host || !connected || discovery.checking} onClick={() => void check()}><AgentIcon name="refresh" />{discovery.checking ? "Checking…" : "Refresh"}</button><button className="agent-button" onClick={home}>Back to conversations</button></div>
        {discovery.error && <p className="agent-error" role="alert">{discovery.error}</p>}
        <div className="agent-local-settings"><h2>History on this device</h2><p>Conversations and drafts stay available when your server is offline.</p><code>{storage.path || "Opening local storage…"}</code></div>
      </section> : <>
        <div ref={scroll.viewport} className="agent-conversation" tabIndex={0} aria-label="Conversation" onScroll={scroll.onScroll} onWheel={scroll.onWheel}>
          <div ref={scroll.content} className="agent-message-list">
            {current ? <>{firstItem > 0 && <div className="agent-history-page"><button onClick={loadEarlier}>Load earlier activity <span>{firstItem} more</span></button><button className="agent-link-button" onClick={() => { setTimelineQuery(""); setTimelineOpen(true) }}>Find a message</button></div>}<AgentTimeline items={visibleItems} agentName={current.agentName} plan={plan} />{!items.length && <div className="agent-thread-empty"><AgentIcon name="chat" size={25} /><h2>{current.state === "connecting" ? `Connecting ${current.agentName}…` : idle(current) ? `${current.agentName} is ready` : current.state === "saved" ? "Saved conversation" : "Agent connection unavailable"}</h2><p>{current.state === "connecting" ? "Loading the models and commands from your server." : idle(current) ? "Send a message to get started." : "Your conversation remains available on this device."}</p></div>}{current.turnActive && !current.pendingInput && !current.pendingPermission && <div className="agent-working" role="status"><span className="agent-status-dot working" />{current.lastError?.includes("Cancellation") ? "Stopping…" : "Working…"}</div>}</>
              : view === "draft" ? <div className="agent-welcome"><div className="agent-welcome-symbol"><AgentIcon name="chat" size={26} /></div><h1>What are we working on?</h1><p>{context ? <>A new conversation in <strong>{projectName}</strong>.</> : "Choose a project, then make something happen."}</p>{!context && <div className="agent-project-choices">{sortedProjects.slice(0, 4).map(p => <button key={projectKey(p)} onClick={() => assignProject(p)}><AgentIcon name="folder" /><span>{p.name || folderName(p.folder)}<small>{hostLabel(p.host)}</small></span><AgentIcon name="chevron" size={13} /></button>)}<button onClick={chooseFolder}><AgentIcon name="plus" /><span>Add a project</span></button></div>}</div>
                : <div className="agent-home"><div className="agent-home-heading"><span className="agent-home-caption">{view === "project" ? hostLabel(context!.host) : "Your workspace"}</span><h1>{view === "project" ? projectName : archived ? "Archived conversations" : "Pick up where you left off."}</h1><p>{view === "project" ? context!.folder : "Your projects. Your agents. One place to continue."}</p><button className="agent-primary" onClick={() => newThread(view === "project" ? context : null)}><AgentIcon name="plus" />{view === "project" ? "New conversation here" : "Start a conversation"}</button></div>
                  {recent.length > 0 ? <div className="agent-recents"><div className="agent-section-label">{archived ? "Archived" : "Recent conversations"}<span>{recent.length}</span></div>{recent.slice(0, 30).map(row => <button key={row.meta.id} className="agent-recent" onClick={() => selectThread(row)}><AgentIcon name={row.meta.pinned ? "pin" : "chat"} size={17} /><span><strong>{threadTitle(row)}</strong><small>{folderName(row.meta.folder)} · {row.agentName}</small></span><time>{new Date(row.meta.activityAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><AgentIcon name="chevron" size={14} /></button>)}</div> : <div className="agent-home-empty"><AgentIcon name="folder" size={22} /><div><h2>{archived ? "Nothing archived yet" : "A place for your next idea"}</h2><p>{archived ? "Archived conversations stay saved and can be restored anytime." : "Add a remote project. Your conversations are saved here, on this device."}</p>{!archived && <button className="agent-link-button" onClick={chooseFolder}>Add your first project <AgentIcon name="arrow" size={14} /></button>}</div></div>}
                  {session && connectionNotice}
                </div>}
          </div>
        </div>
        {showComposer && <div className="agent-composer-area">
          {!scroll.atLatest && current && <button className="agent-jump" onClick={scroll.follow}>Latest activity <AgentIcon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} /></button>}
          {context && <div className="agent-context-line"><AgentIcon name="folder" size={14} /><span title={context.folder}>{context.folder}</span><small title={hostLabel(context.host)}>{hostLabel(context.host)}</small>{!current && <button className="agent-link-button" onClick={() => setProjectChoices(!projectChoices)}>Change</button>}</div>}
          {projectChoices && <div className="agent-context-choices"><div><strong>Switch project</strong><button className="agent-icon-button" aria-label="Close project choices" onClick={() => setProjectChoices(false)}><AgentIcon name="close" size={14} /></button></div>{projects.map(p => <button key={projectKey(p)} className="agent-project-choice" onClick={() => newThread(p)}><AgentIcon name="folder" size={14} /><span>{p.name || folderName(p.folder)}<small>{hostLabel(p.host)} · {p.folder}</small></span></button>)}<button className="agent-link-button" onClick={() => { setProjectChoices(false); chooseFolder() }}>Add another project</button></div>}
          {current?.state === "saved" ? <><div className="agent-saved-notice"><span><AgentIcon name="check" size={15} />Saved on this device</span>{canResumeAgentThread(current) && (connectedHere ? <button className="agent-button" disabled={busy} onClick={() => void resume()}>Resume conversation</button> : <button className="agent-button" onClick={() => { if (current.meta.hostKey === host) void onConnect?.(); else selectHost(current.meta.hostKey) }}>Connect to resume</button>)}</div>{current.meta.hostKey === host && !connected && connectionNotice}</> : context && connectionNotice}
          {current?.pendingPermission && <PermissionCard request={current.pendingPermission} busy={busy} respond={option => void run(() => respondAgentPermission(current.executionId, current.pendingPermission!.requestId, option))} />}
          {current?.pendingInput && <InputCard key={`${current.executionId}:${current.pendingInput.requestId}`} request={current.pendingInput} busy={busy} respond={answers => void run(() => nativeBridge.agentRespondInput(current.executionId, current.pendingInput!.requestId, answers))} />}
          {(error || current?.lastError && ["error", "submissionUnknown"].includes(current.state)) && <div className="agent-error" role="alert"><span>{error || current?.lastError}</span>{current && canResumeAgentThread(current) && <button className="agent-button" disabled={busy || !connectedHere} onClick={() => void resume()}>Resume conversation</button>}</div>}
          <form className="agent-composer" onSubmit={e => { e.preventDefault(); void send() }}>
            {commandOpen && <CommandPicker commands={commands} query={commandQuery} onQuery={setCommandQuery} onSelect={chooseCommand} onClose={() => { setCommandOpen(false); textarea.current?.focus() }} loading={catalogBusy} error={catalogError} refresh={() => void refreshCatalog()} />}
            <textarea ref={textarea} aria-label="Message agent" rows={2} placeholder={context ? "Ask, build, or explore. Type / for commands." : "Start with an idea…"} value={draft} onChange={e => { setDraft(e.target.value); if (e.target.value === "/" || e.target.value === "@") { setCommandQuery(e.target.value === "@" ? "skill:" : ""); setCommandOpen(true) } }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
            <div className="agent-composer-toolbar"><div className="agent-composer-controls">
              {!context ? <button type="button" className="agent-control agent-choose-project" onClick={chooseFolder}><AgentIcon name="folder" size={15} />Choose project<AgentIcon name="chevron" size={12} /></button> : !current ? <ConfigPicker option={providerOption} disabled={busy} change={(_, value) => setPrefs(old => ({ ...old, agent: String(value) }))} /> : <span className="agent-composer-provider">{current.agentName}</span>}
               {fields.filter(option => option.category === "model").map(option => <ConfigPicker key={`${contextKey}:${current?.meta.id || "draft"}:${option.id}`} option={option} disabled={current ? !idle(current) || busy || configBusy : busy} change={(id, value) => void changeConfig(id, value)} />)}
              <button type="button" className="agent-icon-button" aria-label="Conversation settings" title="Conversation settings" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><AgentIcon name="settings" size={16} /></button><button type="button" className="agent-icon-button" aria-label="Commands" title="Commands · Ctrl+P" aria-expanded={commandOpen} onClick={() => { setCommandQuery(""); setCommandOpen(!commandOpen) }}><AgentIcon name="command" size={15} /></button>
            </div>{current?.turnActive ? <button className="agent-send agent-stop" type="button" aria-label="Stop agent" title="Stop agent" disabled={busy} onClick={() => void run(() => cancelAgentTurn(current.executionId))}><AgentIcon name="stop" size={15} /></button> : <button className="agent-send" type="submit" aria-label="Send message" title="Send message" disabled={!canSend}><AgentIcon name="arrow" size={18} /></button>}</div>
            {advanced && <div className="agent-advanced"><div className="agent-advanced-header"><strong>Conversation settings</strong><button type="button" className="agent-icon-button" aria-label="Close conversation settings" onClick={() => setAdvanced(false)}><AgentIcon name="close" size={15} /></button></div>{fields.filter(option => option.category !== "model").map(option => <div className="agent-setting-row" key={option.id}><span>{option.name}</span><ConfigPicker option={option} disabled={current ? !idle(current) || busy || configBusy : busy} change={(id, value) => void changeConfig(id, value)} /></div>)}{!fields.length && <p>{context ? "Connect the agent to load its available settings." : "Choose a project to load agent settings."}</p>}{current ? current.state !== "saved" && <button type="button" className="agent-button" disabled={busy} onClick={() => void run(() => refreshAgentThread(current.executionId))}><AgentIcon name="refresh" size={14} />Refresh session</button> : <button className="agent-button" type="button" disabled={busy || !available?.available || !connectedHere} onClick={() => void run(start)}>Connect {definition.label}</button>}</div>}
          </form>
          <div className="agent-composer-footnote"><span>{!context ? "Choose where this conversation runs before sending." : discovery.checking ? "Finding installed agents…" : !current && connectedHere && available && !available.available ? `${definition.label}: ${available.installed ? "integration unavailable — see Agent settings" : "not installed — choose another coding agent"}` : "Enter to send · Shift+Enter for a new line"}</span>{catalogBusy && <span>Loading project commands…</span>}</div>
        </div>}
      </>}
      {(undo || feedback) && <div className="agent-toast" role="status">{undo ? `Conversation ${undo.at ? "restored" : "archived"}` : feedback}{undo && <button onClick={() => { updateThreadMeta(undo.id, { archivedAt: undo.at }); setUndo(null) }}>Undo</button>}<button className="agent-icon-button" aria-label="Dismiss notification" onClick={() => { setUndo(null); setFeedback("") }}><AgentIcon name="close" size={13} /></button></div>}
    </main>
    {timelineOpen && <div className="agent-confirm-backdrop"><section className="agent-modal" role="dialog" aria-modal="true" aria-label="Find a message"><div className="agent-modal-heading"><h2>Find a message</h2><button className="agent-icon-button" aria-label="Close message search" onClick={() => setTimelineOpen(false)}><AgentIcon name="close" /></button></div><label className="agent-field">Search this conversation<input autoFocus value={timelineQuery} onChange={e => setTimelineQuery(e.target.value)} /></label><div className="agent-timeline-results">{items.filter(item => ["user", "assistant"].includes(item.kind) && item.text.toLowerCase().includes(timelineQuery.toLowerCase())).map(item => <button key={item.id} onClick={() => findMessage(item.id)}><small>{item.kind === "user" ? "You" : current?.agentName}</small><span>{item.text.slice(0, 160)}</span></button>)}</div></section></div>}
    {folderOpen && <div className="agent-confirm-backdrop"><section className="agent-modal agent-folder-picker" role="dialog" aria-modal="true" aria-labelledby="agent-project-title"><div className="agent-modal-heading"><div><h2 id="agent-project-title">Choose a project</h2><p>A folder on the server where your agent will work.</p></div><button className="agent-icon-button" aria-label="Close project picker" onClick={closeFolder}><AgentIcon name="close" /></button></div>
      {addingServer ? <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const port = Number(data.get("port")), hostname = String(data.get("hostname") || "").trim(), username = String(data.get("username") || "").trim(); if (!hostname || !username || !Number.isInteger(port) || port < 1 || port > 65535) return; const key = JSON.stringify([hostname.toLowerCase(), port, username]); const profile = sessionForHost(key, hosts); folderOperation.current++; setFolderHost(key); if (profile) onSelectHost?.({ ...profile, authMethod: data.get("auth") === "key" ? "key" : "ask" }); setAddingServer(false) }}><label className="agent-field">Host<input required name="hostname" placeholder="server.example.com" /></label><div className="agent-server-fields"><label className="agent-field">Username<input required name="username" placeholder="dev" /></label><label className="agent-field">Port<input required type="number" min={1} max={65535} name="port" defaultValue="22" /></label></div><label className="agent-field">Authentication<select name="auth"><option value="ask">Password or saved credential</option><option value="key">Private key</option></select></label><div className="agent-inline-actions"><button className="agent-primary">Use this server</button><button type="button" className="agent-button" onClick={() => setAddingServer(false)}>Back</button></div></form> : <form onSubmit={e => { e.preventDefault(); void openFolder() }}><label className="agent-field">Server<select aria-label="Project server" value={folderHost} disabled={busy} onChange={e => { folderOperation.current++; setFolderHost(e.target.value); if (e.target.value) selectHost(e.target.value) }}><option value="">Choose a server</option>{hosts.map(s => <option key={hostKey(s)} value={hostKey(s)}>{s.name} · {s.username}@{s.host}</option>)}</select></label><button type="button" className="agent-link-button" disabled={busy} onClick={() => setAddingServer(true)}>Add a server</button><label className="agent-field">Remote project folder<input required autoComplete="off" aria-label="Remote project folder" disabled={busy} value={folderPath} onChange={e => { folderOperation.current++; setFolderPath(e.target.value) }} placeholder="~/projects/my-app" /></label>{folderHost === host && connectionNotice}{error && <p className="agent-error" role="alert">{error}</p>}<div className="agent-inline-actions"><button className="agent-primary" disabled={busy || !connected || folderHost !== host || !folderPath.trim()}>Open folder</button><button type="button" className="agent-button" onClick={closeFolder}>Cancel</button></div></form>}
    </section></div>}
    {deleting && <div className="agent-confirm-backdrop"><section className="agent-modal agent-confirm" role="alertdialog" aria-labelledby="agent-delete-title"><h2 id="agent-delete-title">Delete this conversation?</h2><p>“{threadTitle(deleting)}” will be removed from Still. Project files, terminal sessions, and the agent’s own saved history are kept.</p>{deleting.turnActive && <p>Stop the agent before deleting this conversation.</p>}{error && <p className="agent-error" role="alert">{error}</p>}<div className="agent-inline-actions"><button className="agent-button" onClick={() => setDeleting(null)}>Cancel</button>{deleting.turnActive ? <button className="agent-primary" disabled={busy} onClick={() => void run(async () => { await cancelAgentTurn(deleting.executionId); setDeleting(null) })}>Stop agent</button> : <button className="agent-danger" disabled={busy} onClick={() => void run(async () => { await deleteAgentThread(deleting.executionId); if (selected === deleting.meta.id) home(); setDeleting(null) })}>Delete conversation</button>}</div></section></div>}
  </section>
}
