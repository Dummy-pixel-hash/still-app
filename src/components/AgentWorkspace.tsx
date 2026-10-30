/* THESIS: A real coding workspace: choose a project, make a request, inspect its changes.
 * OWN-WORLD: Neutral black, a horizontal red particle horizon, frosted writing surfaces,
 * identifiable providers, syntax-colored code and honest red/green file changes.
 * STORY: Start in the centered composer or reopen local work; review beside the chat.
 * FIRST VIEWPORT: 272px collapsible project navigation, 54px work header, a centered
 * launch area that becomes a 960px transcript and floating composer. Review opens right.
 * FORM: User-pinned T3 Code/Codex desktop canon, grounded in their actual screenshots.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AGENTS, type AgentAvailability, type AgentCatalog, type AgentCommand, type AgentLaunchOptions } from "../agents/types"
import { conversation } from "../agents/transcript"
import { agentServerProfile, folderName, hostKey, hostLabel, normalizeFolder, projectKey, readLibraryPreferences, sessionForHost, type AgentLibraryPreferences, type AgentProject } from "../agents/workspace"
import { useConversationScroll } from "../agents/useConversationScroll"
import { useComposerOverlay } from "../agents/useComposerOverlay"
import { useAgentListMotion } from "../agents/useAgentListMotion"
import { useAgentPopover } from "../agents/useAgentPopover"
import { usePreparedAgent } from "../agents/usePreparedAgent"
import { commandInventory } from "../agents/commands"
import { canChangeAgentHistory, changeAgentHistory, canResumeAgentThread, cancelAgentTurn, claimAgentThreads, clearAgentDraft, deleteAgentThread, loadAgentThreads, reconcileAgentRequest, refreshAgentCommands, refreshAgentThread, respondAgentInput, respondAgentPermission, resumeAgentThread, sendAgentMessage, setAgentConfig, subscribeRemoteAgent, threadTitle, updateThreadMeta, useAgentThreads, type AgentThreadRow } from "../session/agentThreads"
import { discoverAgents, useAgentDiscovery } from "../session/agentDiscovery"
import { flushAgentSaves, saveAgentWorkspace, useAgentStorage } from "../session/agentStorage"
import { nativeBridge } from "../bridge/nativeBridge"
import type { Session } from "../types"
import AgentIcon from "./AgentIcon"
import AgentMenu from "./AgentMenu"
import AgentProviderMark, { StillAgentMark } from "./AgentProviderMark"
import AgentChanges, { AgentChangeSummary } from "./AgentChanges"
import { changeTotals, conversationChanges } from "../agents/changes"
import { CommandPicker, ConfigPicker, modeOption, reasoningOption } from "./AgentControls"
import AgentModelPicker from "./AgentModelPicker"
import AgentAurora from "./AgentAurora"
import { AgentTimeline } from "./AgentTimeline"
import AgentTodos from "./AgentTodos"
import AgentRequest, { requestOutcomeLabel, type AgentRequestActions } from "./AgentRequest"
import { requestKey, questionFields } from "../agents/requests"
import type { TranscriptItem } from "../agents/transcript"
import "../styles/agent-workspace.css"
import "../styles/agent-materials.css"

type Props = {
  session: Session | null
  sessions?: Session[]
  onSelectHost?: (session: Session | null) => void
  onReattach?: (row: AgentThreadRow) => Promise<void>
  transportId?: string
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
const statusOf = (row: AgentThreadRow) => row.state === "detached" ? "On server" : row.pendingPermission || row.pendingInput ? "Needs you" : row.state === "saved" ? "Saved" : row.state === "connecting" ? "Connecting" : row.state === "rewinding" ? "Reverting" : row.state === "submissionUnknown" ? "Uncertain" : row.state === "error" ? "Failed" : row.turnActive ? "Working" : "Ready"
const historyWindows = new Map<string, string>()
const promptStarters = [
  { icon: "code" as const, label: "Build a feature", prompt: "Help me build a feature in this project. First, look at the structure and ask me what I want to add." },
  { icon: "search" as const, label: "Explore the code", prompt: "Explore this project and explain how the important pieces fit together. Show me where to start." },
  { icon: "check" as const, label: "Review changes", prompt: "Review the changes in this project for bugs, regressions, and missing tests. Explain the most important findings." },
]
function relativeActivity(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000))
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}

export default function AgentWorkspace({ session, sessions = [], onSelectHost, onReattach, transportId, connected = true, connectionNotice, onClose, onOpenTerminal, onStart, onCheck, onCatalog, onResolveFolder }: Props) {
  const allThreads = useAgentThreads(), storage = useAgentStorage()
  const [prefs, setPrefs] = useState<AgentLibraryPreferences>(() => readLibraryPreferences())
  const [hydrated, setHydrated] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [project, setProject] = useState<AgentProject | null>(null)
  const [view, setView] = useState<"home" | "draft" | "project" | "settings">("home")
  const [sidebar, setSidebar] = useState(false), [query, setQuery] = useState(""), [archived, setArchived] = useState(false)
  const [narrowNavigation, setNarrowNavigation] = useState(() => matchMedia("(max-width: 800px)").matches)
  const [menu, setMenu] = useState<string | null>(null)
  const [rename, setRename] = useState<{ id: string; title: string; project?: AgentProject } | null>(null)
  const [deleting, setDeleting] = useState<AgentThreadRow | null>(null)
  const [undo, setUndo] = useState<{ id: string; at?: number } | null>(null)
  const [busy, setBusy] = useState(false), [configBusy, setConfigBusy] = useState(false)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [error, setError] = useState("")
  const [commandOpen, setCommandOpen] = useState(false), [commandQuery, setCommandQuery] = useState("")
  const [modelMenu, setModelMenu] = useState<"model" | "reasoning" | null>(null)
  const [extraControl, setExtraControl] = useState<string | null>(null)
  const [configError, setConfigError] = useState("")
  const [restoring, setRestoring] = useState(false)
  const attachAttempt = useRef("")
  const resumeAttempt = useRef("")
  const [timelineOpen, setTimelineOpen] = useState(false), [timelineQuery, setTimelineQuery] = useState("")
  const [feedback, setFeedback] = useState("")
  const [review, setReview] = useState(false)
  const [todosOpen, setTodosOpen] = useState(false)
  const [historyAction, setHistoryAction] = useState<{ message: TranscriptItem; retry: boolean } | null>(null)
  const [folderOpen, setFolderOpen] = useState(false), [folderHost, setFolderHost] = useState(""), [folderPath, setFolderPath] = useState("")
  const [projectChoices, setProjectChoices] = useState(false)
  const [addingServer, setAddingServer] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState(false), [catalogError, setCatalogError] = useState("")
  const [requestDrafts, setRequestDrafts] = useState<Record<string, Record<string, unknown>>>({})
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({})
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null)
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null)
  const requestOperations = useRef(new Set<string>())
  const [draftGeneration, setDraftGeneration] = useState(0)
  const [, updateHistoryWindow] = useState(0)
  const surface = useRef<HTMLElement>(null), textarea = useRef<HTMLTextAreaElement>(null), search = useRef<HTMLInputElement>(null)
  const sidebarToggle = useRef<HTMLButtonElement>(null)
  const navigationPanel = useRef<HTMLElement>(null)
  const projectPopover = useRef<HTMLDivElement>(null), returnFocus = useRef<HTMLElement | null>(null)
  useAgentPopover(projectPopover, projectChoices, "start", true)
  const navigation = useRef(0), mounted = useRef(true), prefsRef = useRef(prefs)
  const folderOperation = useRef(0)
  const callbacks = useRef({ onCheck, onCatalog, onStart }); callbacks.current = { onCheck, onCatalog, onStart }; prefsRef.current = prefs
  const host = session ? hostKey(session) : ""
  const discovery = useAgentDiscovery(host)
  const libraryThreads = allThreads.filter(row => !row.meta.prepared || row.state === "saved" || !!row.meta.draft || row.transcript.some(event => event.type === "userMessage"))
  const current = libraryThreads.find(row => row.meta.id === selected) || null
  const context = current ? { host: current.meta.hostKey, folder: current.meta.folder } : project
  const contextKey = context ? projectKey(context) : "unassigned"
  const connectedHere = !!context && context.host === host && connected
  useEffect(() => {
    if (!current?.persistent || !onReattach || !transportId || !connectedHere || !["saved", "detached"].includes(current.state)) return
    const key = `${current.executionId}:${transportId}:${current.state}`
    if (attachAttempt.current === key) return
    attachAttempt.current = key
    const revision = navigation.current
    setRestoring(true)
    void onReattach(current).catch(failure => { if (mounted.current && revision === navigation.current) setError(messageOf(failure)) }).finally(() => { if (mounted.current && revision === navigation.current) setRestoring(false) })
  }, [current?.executionId, current?.state, transportId, connectedHere, onReattach])
  useEffect(() => {
    if (!current || current.persistent || current.state !== "saved" || !canResumeAgentThread(current) || !onStart || !transportId || !connectedHere) return
    const key = `${current.executionId}:${transportId}`
    if (resumeAttempt.current === key) return
    resumeAttempt.current = key
    const revision = navigation.current
    setRestoring(true)
    const start = (agent: string, options: AgentLaunchOptions) => {
      const launch = callbacks.current.onStart
      return launch ? launch(agent, options) : Promise.reject(new Error("Connect an agent before resuming this conversation."))
    }
    const resumeExecutable = prefsRef.current.executables[current.meta.hostKey]?.[current.agentId]?.trim() || undefined
    void resumeAgentThread(current.executionId, start, resumeExecutable).then(next => {
      if (mounted.current && revision === navigation.current) setSelected(next.meta.id)
    }).catch(failure => {
      if (mounted.current && revision === navigation.current) setError(messageOf(failure))
    }).finally(() => {
      if (mounted.current && revision === navigation.current) setRestoring(false)
    })
  }, [current?.executionId, current?.state, current?.persistent, current?.meta.hostKey, current?.agentId, transportId, connectedHere, onStart])
  const agentId = current?.agentId || prefs.agent
  const definition = AGENTS.find(agent => agent.id === agentId) || AGENTS[0]
  const executable = context ? prefs.executables[context.host]?.[agentId]?.trim() || undefined : undefined
  const available = discovery.agents.find(agent => agent.agentId === agentId)
  const draftKey = project ? projectKey(project) : "unassigned"
  const configurationKey = JSON.stringify([contextKey, agentId, executable])
  const startScreen = !current && !archived && view !== "settings"
  const preparing = hydrated && startScreen && connectedHere && available?.available === true && !discovery.checking
  const preparation = usePreparedAgent(`${configurationKey}:${draftGeneration}`, preparing, agentId, { cwd: context?.folder, executable }, context?.host || "", onStart)
  const prepared = allThreads.find(row => row.meta.id === preparation.id) || null
  const activeAgent = current || prepared
  const draft = current ? current.meta.draft : prefs.drafts[draftKey] || ""
  const fields = activeAgent?.configOptions || []
  const modelControl = fields.find(option => option.category === "model")
  const reasoningControl = reasoningOption(fields)
  const agentModeControl = modeOption(fields)
  const otherControls = fields.filter(option => option !== modelControl && option !== reasoningControl && option !== agentModeControl)
  const items = useMemo(() => {
    const transcript = conversation(current?.transcript || [])
    if (!current) return transcript
    const kind = current.pendingPermission ? "permission" : current.pendingInput ? "question" : undefined
    const request = current.pendingPermission || current.pendingInput
    if (!kind || !request) return transcript
    const found = [...transcript].reverse().find(item => item.kind === "request" && item.attemptId === current.executionId && item.requestKind === kind && item.requestId === request.requestId)
    if (found) {
      if (kind === "permission") found.permission = current.pendingPermission
      else found.agentInput = current.pendingInput
    } else transcript.push({ id: `pending-${requestKey(current.executionId, kind, request.requestId)}`, kind: "request", attemptId: current.executionId, requestKind: kind, requestId: request.requestId, title: request.title, text: "", permission: current.pendingPermission, agentInput: current.pendingInput })
    return transcript
  }, [current?.transcript, current?.pendingPermission, current?.pendingInput])
  const changes = useMemo(() => conversationChanges(items), [items])
  const openHistoryAction = useCallback((message: TranscriptItem, retry: boolean) => { setError(""); setHistoryAction({ message, retry }) }, [])
  const historyActions = useMemo(() => ({ capabilities: current?.historyCapabilities, enabled: connectedHere && !busy && !configBusy && !!current && !current.turnActive && !current.pendingInput && !current.pendingPermission && !current.meta.archivedAt && !current.meta.submissionUnknown && ["working", "complete", "cancelled", "error"].includes(current.state), act: openHistoryAction }), [current?.historyCapabilities, current?.state, current?.turnActive, current?.pendingInput, current?.pendingPermission, current?.meta.archivedAt, current?.meta.submissionUnknown, connectedHere, busy, configBusy, openHistoryAction])
  const changeCount = useMemo(() => changeTotals(changes), [changes])
  const historyId = current?.meta.id || ""
  const historyStart = historyWindows.get(historyId)
  const firstItem = historyStart === undefined ? Math.max(0, items.length - 120) : historyStart === "" ? 0 : Math.max(0, items.findIndex(item => item.id === historyStart))
  const visibleItems = useMemo(() => items.slice(firstItem), [items, firstItem])
  const turnActive = !!(current?.turnActive && !current.pendingInput && !current.pendingPermission)
  const lastVisibleUser = visibleItems.reduce((last, item, index) => item.kind === "user" ? index : last, -1)
  const hasActiveReasoning = turnActive && visibleItems.some((item, index) => item.kind === "reasoning" && (lastVisibleUser < 0 || index > lastVisibleUser))
  useLayoutEffect(() => { if (historyId && !historyWindows.has(historyId)) historyWindows.set(historyId, items[firstItem]?.id || "") }, [historyId, items, firstItem])
  const plan = useMemo(() => current?.transcript.slice().reverse().find(event => event.type === "plan")?.plan, [current?.transcript])
  const scroll = useConversationScroll(current?.meta.id || `${view}:${contextKey}`, current?.transcript)
  const showComposer = startScreen || !!current
  const composerCollapsed = !!current && !composerExpanded
  const composerDock = useComposerOverlay(!!current)
  const canSend = hydrated && connectedHere && !busy && !configBusy && !!draft.trim() && (current ? idle(current) && !current.meta.archivedAt : preparation.ready && idle(prepared))
  const threads = libraryThreads.filter(row => !!row.meta.archivedAt === archived && (!query || `${threadTitle(row)} ${row.meta.folder} ${hostLabel(row.meta.hostKey)} ${row.agentName}`.toLowerCase().includes(query.toLowerCase())))
  const projects = [...prefs.projects]
  for (const row of libraryThreads) if (!projects.some(p => p.host === row.meta.hostKey && p.folder === row.meta.folder)) projects.push({ host: row.meta.hostKey, folder: row.meta.folder })
  const activity = (p: AgentProject) => Math.max(0, ...libraryThreads.filter(row => row.meta.hostKey === p.host && row.meta.folder === p.folder).map(row => row.meta.activityAt))
  const sortedProjects = projects.filter(p => !query || threads.some(row => row.meta.hostKey === p.host && row.meta.folder === p.folder)).sort((a, b) => prefs.sort === "name" ? (a.name || folderName(a.folder)).localeCompare(b.name || folderName(b.folder)) : prefs.sort === "recent" ? activity(b) - activity(a) : 0)
  const listMotion = useAgentListMotion(JSON.stringify([sortedProjects.map(projectKey), prefs.collapsed, prefs.sort, threads.map(row => [row.meta.id, row.meta.order, row.meta.pinned, row.meta.activityAt])]))
  const knownServers = [...prefs.servers, ...sessions, ...(session ? [session] : [])]
  const hosts = [...new Map([...projects.map(p => sessionForHost(p.host, knownServers)).filter((s): s is Session => !!s), ...knownServers].map(s => [hostKey(s), s])).values()]
  const providerCommands = activeAgent?.commands || []
  const commands = commandInventory(providerCommands, agentId, otherControls)
  const sidebarExpanded = sidebar || !prefs.sidebarCollapsed
  const sidebarOverlay = sidebar && narrowNavigation
  const dialogOpen = folderOpen || !!deleting || timelineOpen || !!historyAction || !!extraControl || !!expandedRequest
  const attentionCount = allThreads.filter(row => row.pendingPermission || row.pendingInput).length
  const activeRequestKind = current?.pendingPermission ? "permission" : current?.pendingInput ? "question" : undefined
  const activeRequestId = current?.pendingPermission?.requestId ?? current?.pendingInput?.requestId
  const requestKeyFor = (kind: "question" | "permission", id: string | number) => requestKey(current?.executionId || "", kind, id)
  const activeRequestKey = activeRequestKind && activeRequestId !== undefined ? requestKeyFor(activeRequestKind, activeRequestId) : undefined
  const activeRequestItem = [...items].reverse().find(item => item.kind === "request" && item.attemptId === current?.executionId && item.requestKind === activeRequestKind && item.requestId === activeRequestId && !item.requestOutcome)
  useLayoutEffect(() => { if (activeRequestItem) scroll.revealRequest(activeRequestItem.id) },[activeRequestItem?.id])
  const expandedItem = items.find(item => item.id === expandedRequest)
  const requestActions: AgentRequestActions = {
    activeKey: activeRequestKey,
    busy: requestBusyId === activeRequestKey,
    available: connectedHere && current?.state === "inputRequired",
    expandedId: expandedRequest,
    expand: id => { setModelMenu(null); setCommandOpen(false); setProjectChoices(false); setExpandedRequest(id) },
    keyFor: item => requestKey(item.attemptId || "historical", item.requestKind || "question", item.requestId ?? ""),
    answersFor: (key, request) => requestDrafts[key] || Object.fromEntries(questionFields(request).fields.filter(([, field]) => field.type === "boolean").map(([id]) => [id, false])),
    errorFor: key => requestErrors[key],
    updateAnswers: (key, answers) => setRequestDrafts(old => ({ ...old, [key]: answers })),
    answer: (item, answers) => {
      if (!current || item.attemptId !== current.executionId || item.requestId === undefined || !item.agentInput || !connectedHere) return
      const executionId = current.executionId, key = requestKeyFor("question", item.requestId)
      if (requestOperations.current.has(key)) return
      requestOperations.current.add(key)
      setRequestBusyId(key); setRequestErrors(old => { const next = { ...old }; delete next[key]; return next })
      void respondAgentInput(executionId, item.requestId, answers).then(() => {
        setRequestDrafts(old => { const next = { ...old }; delete next[key]; return next })
      }).catch(failure => {
        setRequestErrors(old => ({ ...old, [key]: messageOf(failure) }))
      }).finally(() => { requestOperations.current.delete(key); setRequestBusyId(old => old === key ? null : old) })
    },
    permission: (item, optionId) => {
      if (!current || item.attemptId !== current.executionId || item.requestId === undefined || !item.permission || !connectedHere) return
      const executionId = current.executionId, key = requestKeyFor("permission", item.requestId)
      if (requestOperations.current.has(key)) return
      requestOperations.current.add(key)
      setRequestBusyId(key); setRequestErrors(old => { const next = { ...old }; delete next[key]; return next })
      void respondAgentPermission(executionId, item.requestId, optionId).catch(failure => {
        setRequestErrors(old => ({ ...old, [key]: messageOf(failure) }))
      }).finally(() => { requestOperations.current.delete(key); setRequestBusyId(old => old === key ? null : old) })
    },
    reconcile: item => {
      if (!current || item.attemptId !== current.executionId || item.requestId === undefined || !item.requestKind || !connectedHere) return
      const key = requestKeyFor(item.requestKind, item.requestId)
      if (requestOperations.current.has(key)) return
      requestOperations.current.add(key); setRequestBusyId(key)
      void reconcileAgentRequest(current.executionId, item.requestKind, item.requestId).then(() => {
        setRequestErrors(old => { const next = { ...old }; delete next[key]; return next })
      }).catch(failure => setRequestErrors(old => ({ ...old, [key]: messageOf(failure) }))).finally(() => { requestOperations.current.delete(key); setRequestBusyId(old => old === key ? null : old) })
    },
  }
  const previousRequest = useRef<TranscriptItem | null>(null)
  useEffect(() => {
    const prior = previousRequest.current
    if (prior && !activeRequestItem && prior.attemptId === current?.executionId) {
      const result = items.find(item => item.id === prior.id)
      if (result) setFeedback(requestOutcomeLabel(result))
    }
    previousRequest.current = activeRequestItem || null
  }, [activeRequestItem, current?.executionId, items])
  const savedStatus = !hydrated ? "Opening history…" : storage.error ? "Changes need saving" : storage.pending ? "Saving locally…" : "Saved on this device"
  useEffect(() => {
    const media = matchMedia("(max-width: 800px)")
    const update = () => { setNarrowNavigation(media.matches); if (!media.matches) setSidebar(false) }
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  useLayoutEffect(() => {
    if (!sidebarOverlay) return
    const panel = navigationPanel.current
    if (!panel?.contains(document.activeElement)) sidebarToggle.current?.focus({ preventScroll: true })
    return () => { requestAnimationFrame(() => {
      if (!surface.current || !matchMedia("(max-width: 800px)").matches || panel?.getAttribute("aria-modal") === "true") return
      if (document.activeElement === document.body || panel?.contains(document.activeElement)) surface.current.querySelector<HTMLButtonElement>(".agent-mobile-menu")?.focus({ preventScroll: true })
    }) }
  }, [sidebarOverlay])

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
  useEffect(() => { setCatalogError(""); setConfigError(""); setConfigBusy(false); setHistoryAction(null); setModelMenu(null); setExtraControl(null); setExpandedRequest(null) }, [contextKey, agentId, selected])
  useEffect(() => { if (current) void subscribeRemoteAgent(current.executionId); setError(""); setMenu(null); setCommandOpen(false) }, [selected, current?.executionId])
  useEffect(() => { setReview(false); setTodosOpen(false) }, [selected, view])
  useEffect(() => { if (!current?.todos?.items.length) setTodosOpen(false) }, [current?.meta.id, current?.todos?.items.length])
  useEffect(() => {
    const input = textarea.current
    if (!input) return
    if (composerCollapsed) { input.style.height = ""; return }
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 156)}px`
  }, [draft, selected, view, composerCollapsed])
  useEffect(() => { mounted.current = true; const previous = document.activeElement as HTMLElement | null; surface.current?.focus(); return () => { mounted.current = false; void flushAgentSaves(); if (previous?.isConnected) previous.focus() } }, [])
  useLayoutEffect(() => {
    if (!dialogOpen) return
    const previous = returnFocus.current
    const modal = surface.current?.querySelector<HTMLElement>(".agent-modal")
    const target = expandedRequest ? modal?.querySelector<HTMLElement>('[aria-label="Close expanded request"]') : modal?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled)') || modal?.querySelector<HTMLElement>('button:not(:disabled)')
    target?.focus({ preventScroll: true })
    return () => { requestAnimationFrame(() => {
      if (surface.current?.querySelector(".agent-modal")) return
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true })
      else if (expandedRequest) (surface.current?.querySelector<HTMLElement>(`[data-timeline-id="${CSS.escape(expandedRequest)}"] .agent-request-expand`) || textarea.current)?.focus({ preventScroll: true })
      else textarea.current?.focus({ preventScroll: true })
    }) }
  }, [folderOpen, !!deleting, timelineOpen, !!historyAction, extraControl, expandedRequest])
  useEffect(() => {
    if (!projectChoices) return
    const outside = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('.agent-context-choices,[data-agent-popover-trigger]')) setProjectChoices(false)
    }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [projectChoices])

  const setDraft = (text: string) => current ? updateThreadMeta(current.executionId, { draft: text }) : setPrefs(old => ({ ...old, drafts: { ...old.drafts, [draftKey]: text } }))
  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation() } catch (e) { setError(messageOf(e)) } finally { if (mounted.current) setBusy(false) } }
  const selectHost = (key: string) => { const server = sessionForHost(key, hosts); if (server) onSelectHost?.(server) }
  const revealProjects = (focusSearch = false) => {
    setMenu(null)
    setCommandOpen(false); setProjectChoices(false); setModelMenu(null)
    if (matchMedia("(max-width: 800px)").matches) { setReview(false); setSidebar(true) }
    else setPrefs(old => ({ ...old, sidebarCollapsed: false }))
    if (focusSearch) requestAnimationFrame(() => search.current?.focus({ preventScroll: true }))
  }
  const toggleProjects = () => {
    setMenu(null)
    if (matchMedia("(max-width: 800px)").matches) {
      setSidebar(false)
      requestAnimationFrame(() => surface.current?.querySelector<HTMLButtonElement>(".agent-mobile-menu")?.focus({ preventScroll: true }))
    } else {
      setPrefs(old => ({ ...old, sidebarCollapsed: !old.sidebarCollapsed }))
      requestAnimationFrame(() => sidebarToggle.current?.focus({ preventScroll: true }))
    }
  }
  const home = () => { navigation.current++; setSelected(null); setProject(null); setView("home"); setCommandOpen(false); setMenu(null); setProjectChoices(false); setSidebar(false); setError("") }
  const openProject = (p: AgentProject) => { navigation.current++; setSelected(null); setProject(p); setView("project"); setCommandOpen(false); setMenu(null); setSidebar(false); setError(""); selectHost(p.host) }
  const newThread = (p: AgentProject | null = null) => { navigation.current++; setDraftGeneration(value => value + 1); setSelected(null); setProject(p); setView("draft"); setArchived(false); setCommandOpen(false); setMenu(null); setProjectChoices(false); setSidebar(false); setError(""); if (p) selectHost(p.host); requestAnimationFrame(() => { if (!surface.current?.querySelector(".agent-command-menu")) textarea.current?.focus() }) }
  const assignProject = (p: AgentProject) => {
    if (startScreen && !current && !project && prefsRef.current.drafts.unassigned) {
      const key = projectKey(p)
      if (!prefsRef.current.drafts[key]) setPrefs(old => ({ ...old, drafts: { ...old.drafts, [key]: old.drafts.unassigned, unassigned: "" } }))
      else setFeedback("This project has a draft. Your unassigned idea is kept in New conversation.")
    }
    newThread(p)
  }
  const selectThread = (row: AgentThreadRow) => { navigation.current++; setSelected(row.meta.id); setProject({ host: row.meta.hostKey, folder: row.meta.folder }); setView("draft"); setSidebar(false); selectHost(row.meta.hostKey) }
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
  const start = () => {
    if (!context || !connectedHere || !prepared || !preparation.ready) throw new Error("Wait for the selected agent to finish connecting.")
    preparation.claim()
    updateThreadMeta(prepared.executionId, { prepared: false, draft })
    setSelected(prepared.meta.id); setProject({ host: context.host, folder: prepared.cwd }); setView("draft")
    setPrefs(old => ({ ...old, drafts: { ...old.drafts, [draftKey]: "" } }))
    return prepared
  }
  const chooseCommand = (command: AgentCommand, argument?: string) => {
    if (command.unavailable) { setCatalogError(command.unavailable); setCommandOpen(true); return }
    if (command.route !== "client") { setDraft(command.route === "skill" ? `@${command.name.replace(/^skill:/, "")} ` : `/${command.name} `); setCommandOpen(false); textarea.current?.focus(); return }
    setCommandOpen(false)
    if (command.name === "new") newThread(context)
    else if (command.name === "open") chooseFolder()
    else if (command.name === "sessions") revealProjects(true)
    else if (command.name === "help") { setCommandQuery(""); setCommandOpen(true) }
    else if (command.name === "skills") { setCommandQuery("skill:"); setCommandOpen(true) }
    else if (command.name === "rename") {
      if (!current) { setError("Open a conversation to rename it."); return }
      if (argument?.trim()) updateThreadMeta(current.executionId, { title: argument.trim() })
      else { revealProjects(); setRename({ id: current.executionId, title: threadTitle(current) }) }
    }
    else if (command.name === "copy") {
      if (!current) { setError("Open a saved conversation to copy it."); return }
      const markdown = `# ${threadTitle(current)}\n\n` + items.filter(item => ["user", "assistant", "reasoning"].includes(item.kind)).map(item => `## ${item.kind === "user" ? "You" : item.kind === "reasoning" ? "Reasoning" : current.agentName}\n\n${item.text}`).join("\n\n")
      void nativeBridge.clipboardWriteText(markdown).then(() => setFeedback("Conversation copied")).catch(e => setError(messageOf(e)))
    }
    else if (command.name === "timeline") { if (current) { setTimelineQuery(""); setTimelineOpen(true) } else setError("Open a conversation to find a message.") }
    else if (command.name === "providers") { if (current) setError("Choose a coding agent when starting a new conversation."); else surface.current?.querySelector<HTMLButtonElement>('[data-config-id="provider"] > button')?.click() }
    else if (command.name === "refresh-session") { if (current && current.state !== "saved") void run(() => refreshAgentThread(current.executionId)); else setError("Open a live conversation to refresh its session.") }
    else if (["models", "variants"].includes(command.name)) {
      if (!modelControl && !reasoningControl) { setError(context ? `${definition.label}’s model controls appear when its connection is ready.` : "Choose a project before selecting a model."); return }
      setProjectChoices(false); setModelMenu(command.name === "variants" ? "reasoning" : "model")
    }
    else if (command.name === "agents") {
      if (!agentModeControl) { setError(context ? `${definition.label} has no selectable agent modes for this conversation.` : "Choose a project to load agent modes."); return }
      requestAnimationFrame(() => surface.current?.querySelector<HTMLButtonElement>(`[data-config-id="${CSS.escape(agentModeControl.id)}"] > button`)?.click())
    }
    else if (command.configId) { setExtraControl(command.configId); setConfigError("") }
  }
  const send = async () => {
    const text = draft.trim(), parsed = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    const command = commands.find(c => c.name === parsed?.[1]) || commands.find(c => c.aliases?.includes(parsed?.[1] || ""))
    if (command?.route === "client" || command?.unavailable) { chooseCommand(command, parsed?.[2]); if (!command.unavailable) setDraft(""); return }
    if (!canSend) return
    const revision = navigation.current
    await run(async () => {
      const row = current || start()
      if (!idle(row)) return
      await sendAgentMessage(row.executionId, text); clearAgentDraft(row.executionId, text)
      if (mounted.current && navigation.current === revision) scroll.anchorTurn(row.meta.id)
    })
  }
  const changeConfig = async (id: string, value: string | boolean) => {
    if (!activeAgent) throw new Error("Connect an agent before changing its configuration.")
    const revision = navigation.current
    setConfigBusy(true); setConfigError("")
    try { await setAgentConfig(activeAgent.executionId, id, value) }
    finally { if (mounted.current && revision === navigation.current) setConfigBusy(false) }
  }
  const changeSecondaryConfig = async (id: string, value: string | boolean) => {
    const revision = navigation.current
    try { await changeConfig(id, value) }
    catch (failure) { if (mounted.current && revision === navigation.current) setConfigError(messageOf(failure)) }
  }
  const applyHistoryAction = async () => {
    if (!current || !historyAction?.message.messageId || !connectedHere) return
    const target = current, action = historyAction, revision = navigation.current
    await run(async () => {
      await changeAgentHistory(target.executionId, action.message.messageId!, action.retry)
      if (mounted.current && navigation.current === revision) {
        historyWindows.delete(target.meta.id)
        updateHistoryWindow(value => value + 1)
        setHistoryAction(null)
        setReview(false)
        setFeedback(action.retry ? "Retrying with the selected model" : "Conversation reverted · project files kept")
        requestAnimationFrame(() => { textarea.current?.focus({ preventScroll: true }); scroll.follow() })
      }
    })
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
  const useStarter = (prompt: string) => {
    if (draft.trim()) return
    setDraft(prompt)
    setView("draft")
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(prompt.length, prompt.length) })
  }
  const check = () => discoverAgents(host, () => Promise.all(AGENTS.map(agent => onCheck(agent.id, prefs.executables[host]?.[agent.id]?.trim() || undefined))).then(rows => rows.flat()))
  const refreshCatalog = async () => {
    if (!activeAgent) return
    if (!connectedHere || !onCatalog || agentId !== "opencode") { setCatalogError("Connect this conversation's server to refresh its command inventory."); return }
    const id = activeAgent.executionId, revision = navigation.current
    setCatalogBusy(true); setCatalogError("")
    try {
      const next = await refreshAgentCommands(id, () => onCatalog(agentId, activeAgent.cwd, executable))
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
  const composerNotice = discovery.checking ? "Finding agents…" : catalogBusy ? "Loading commands…" : !current && connectedHere && available && !available.available ? `${definition.label} is unavailable` : null
  const nativeShell = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

  return <section ref={surface} className="agent-workspace" data-native-shell={nativeShell ? "true" : undefined} tabIndex={-1} role="dialog" aria-modal="true" aria-label={session ? `Agents on ${session.name}` : "Agents workspace"}
    onFocusCapture={e => { if (!(e.target as HTMLElement).closest('.agent-modal,.agent-thread-menu,.agent-picker-popup,.agent-model-menu,.agent-command-menu,.agent-context-choices')) returnFocus.current = e.target as HTMLElement }}
    onPointerDown={e => { if (!(e.target as HTMLElement).closest(".agent-thread-menu,.agent-thread-more")) setMenu(null) }}
    onKeyDown={e => {
      e.stopPropagation()
      if (!dialogOpen && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); setSidebar(false); setProjectChoices(false); setModelMenu(null); if (!showComposer) newThread(); setCommandQuery(""); setCommandOpen(true) }
      if (!folderOpen && !timelineOpen && !deleting && !historyAction && (e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault()
        if (matchMedia("(max-width: 800px)").matches && !sidebar) revealProjects()
        else toggleProjects()
      }
      if (e.key === "Escape") { e.preventDefault(); if (expandedRequest) setExpandedRequest(null); else if (extraControl) setExtraControl(null); else if (modelMenu) setModelMenu(null); else if (historyAction) { if (!busy) setHistoryAction(null) } else if (deleting) setDeleting(null); else if (timelineOpen) setTimelineOpen(false); else if (folderOpen) closeFolder(); else if (rename) setRename(null); else if (projectChoices) setProjectChoices(false); else if (commandOpen) setCommandOpen(false); else if (menu) setMenu(null); else if (review) setReview(false); else if (sidebar) setSidebar(false); else if (view === "settings") home(); else onClose() }
      if (e.key === "Tab") {
        const root = surface.current?.querySelector(".agent-modal") || (sidebarOverlay ? surface.current?.querySelector(".agent-thread-menu") || navigationPanel.current : null) || (review && matchMedia("(max-width: 1000px)").matches ? surface.current?.querySelector(".agent-review") : null) || (projectChoices ? projectPopover.current : null) || surface.current
        const elements = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]') || [])].filter(el => el.getClientRects().length && !el.closest("[inert]"))
        if (e.shiftKey && (document.activeElement === elements[0] || document.activeElement === surface.current)) { e.preventDefault(); elements.at(-1)?.focus() }
        else if (!e.shiftKey && document.activeElement === elements.at(-1)) { e.preventDefault(); elements[0]?.focus() }
      }
    }}>
    <AgentAurora />
    {sidebarOverlay && <button className="agent-sidebar-scrim" tabIndex={-1} aria-label="Hide projects" onClick={toggleProjects} />}
    <aside ref={navigationPanel} inert={dialogOpen} className={`agent-sidebar ${sidebarExpanded ? "" : "is-collapsed"} ${sidebar ? "is-open" : ""}`} role={sidebarOverlay ? "dialog" : "complementary"} aria-modal={sidebarOverlay || undefined} aria-label="Projects and conversations">
      <header className="agent-sidebar-top">
        <button className="agent-brand" onClick={() => { setArchived(false); home() }} aria-label="Still conversations"><StillAgentMark size={34} /><strong>Still</strong></button>
        <button ref={sidebarToggle} className="agent-sidebar-toggle" aria-label={sidebarExpanded ? "Collapse project sidebar" : "Expand project sidebar"} title={`${sidebarExpanded ? "Collapse" : "Expand"} project sidebar · Ctrl/⌘+\\`} aria-expanded={sidebarExpanded} aria-controls="agent-project-navigation" onClick={toggleProjects}><AgentIcon name="panel" size={17} /></button>
      </header>
      <div className="agent-sidebar-rail" aria-hidden={sidebarExpanded} inert={sidebarExpanded}>
        <button className="agent-rail-new" aria-label="New conversation" title="New conversation" disabled={!hydrated} onClick={() => newThread()}><AgentIcon name="compose" size={18} /></button>
        <button aria-label="Search conversations" title="Search conversations" onClick={() => revealProjects(true)}><AgentIcon name="search" size={17} /></button>
        <button aria-label={attentionCount ? `Show projects · ${attentionCount} need your input` : "Show projects"} title={attentionCount ? `Projects · ${attentionCount} need your input` : "Show projects"} onClick={() => revealProjects()}><AgentIcon name="folder" size={17} />{attentionCount > 0 && <i className="agent-rail-attention" />}</button>
        <div className="agent-rail-bottom">
          <button aria-label="Agent settings" title="Agent settings" onClick={() => { setView("settings"); setSelected(null); setSidebar(false); setMenu(null) }}><AgentIcon name="settings" size={16} /></button>
          <button className="agent-thread-more" aria-label="Workspace options" title="Workspace options" aria-haspopup="menu" aria-expanded={menu === "sidebar:more"} onClick={() => setMenu(menu === "sidebar:more" ? null : "sidebar:more")}><AgentIcon name="more" size={15} /></button>
          <span className={`agent-rail-storage agent-status-dot ${storage.error ? "attention" : "connected"}`} title={savedStatus} role="status" aria-label={savedStatus} />
        </div>
      </div>
      <div className="agent-sidebar-panel" id="agent-project-navigation" inert={!sidebarExpanded} aria-hidden={!sidebarExpanded}>
        <button className="agent-sidebar-new" aria-label="New conversation" disabled={!hydrated} onClick={() => newThread()}><AgentIcon name="compose" size={17} /><span>New conversation</span></button>
        <label className="agent-sidebar-search"><AgentIcon name="search" size={15} /><input ref={search} aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button className={`agent-sidebar-archive ${archived ? "is-selected" : ""}`} onClick={() => { setArchived(!archived); home() }}><AgentIcon name="archive" size={16} /><span>{archived ? "All conversations" : "Archived"}</span>{allThreads.some(row => row.meta.archivedAt) && <small>{allThreads.filter(row => row.meta.archivedAt).length}</small>}</button>
        <div className="agent-project-heading">
          <span>{archived ? "Archived" : "Projects"}</span>
          <button className="agent-sidebar-view agent-thread-more" aria-label="View options" title="View options" aria-haspopup="dialog" aria-expanded={menu === "sidebar:view"} onClick={() => setMenu(menu === "sidebar:view" ? null : "sidebar:view")}><AgentIcon name="settings" size={14} /></button>
          <button className="agent-icon-button" aria-label="Add project folder" title="Add project" onClick={chooseFolder}><AgentIcon name="plus" size={15} /></button>
        </div>
        <nav ref={listMotion} className="agent-thread-list" aria-label="Conversations by folder">
          {sortedProjects.map(p => {
            const key = projectKey(p), collapsed = prefs.collapsed.includes(key) && !query
            const rows = threads.filter(row => row.meta.hostKey === p.host && row.meta.folder === p.folder).sort((a, b) => Number(b.meta.pinned) - Number(a.meta.pinned) || (prefs.sort === "name" ? threadTitle(a).localeCompare(threadTitle(b)) : prefs.sort === "manual" ? b.meta.order - a.meta.order : b.meta.activityAt - a.meta.activityAt))
            if (archived && !rows.length) return null
            return <div className="agent-folder" key={key}>
              <div className={`agent-folder-heading ${contextKey === key ? "is-current" : ""}`} data-agent-row={`project:${key}`}>
                <button className="agent-icon-button agent-folder-toggle" aria-label={`Toggle ${p.name || folderName(p.folder)} conversations`} aria-expanded={!collapsed} title={p.folder} onClick={() => setPrefs(old => ({ ...old, collapsed: collapsed ? old.collapsed.filter(id => id !== key) : [...old.collapsed, key] }))}><AgentIcon name="chevron" size={12} style={{ transform: collapsed ? "" : "rotate(90deg)" }} /></button>
                {rename?.id === key ? <form className="agent-rename" onSubmit={e => { e.preventDefault(); finishRename() }}><input autoFocus aria-label="Project name" value={rename.title} onChange={e => setRename({ ...rename, title: e.target.value })} onBlur={finishRename} /></form> : <button className="agent-project-open" aria-label={`${p.name || folderName(p.folder)} · ${hostLabel(p.host)}`} title={`${hostLabel(p.host)} · ${p.folder}`} onClick={() => openProject(p)}><AgentIcon name="folder" size={15} /><span>{p.name || folderName(p.folder)}</span></button>}
                <button className="agent-icon-button agent-project-new" aria-label={`New conversation in ${p.folder}`} title="New conversation here" onClick={() => newThread(p)}><AgentIcon name={prefs.drafts[key] ? "edit" : "plus"} size={14} /></button>
                <button className="agent-icon-button agent-thread-more" aria-label={`Project actions for ${p.folder}`} aria-haspopup="menu" aria-expanded={menu === key} onClick={() => setMenu(menu === key ? null : key)}><AgentIcon name="more" size={14} /></button>
                {menu === key && <AgentMenu root={surface.current}><button role="menuitem" onClick={() => { newThread(p); setMenu(null) }}>New conversation</button><button role="menuitem" onClick={() => { setRename({ id: key, title: p.name || folderName(p.folder), project: p }); setMenu(null) }}>Rename project</button><button role="menuitem" onClick={() => moveProject(p, -1)}>Move project up</button><button role="menuitem" onClick={() => moveProject(p, 1)}>Move project down</button><button role="menuitem" disabled={allThreads.some(row => row.meta.hostKey === p.host && row.meta.folder === p.folder)} onClick={() => { setPrefs(old => ({ ...old, projects: old.projects.filter(item => projectKey(item) !== key) })); setMenu(null); if (contextKey === key) home() }}>Remove empty folder</button></AgentMenu>}
              </div>
              {!collapsed && <div className="agent-folder-threads">{rows.map(row => <div key={row.meta.id} data-agent-row={row.meta.id} className={`agent-thread ${selected === row.meta.id ? "is-selected" : ""}`} onContextMenu={e => { e.preventDefault(); setMenu(row.executionId) }}>
                {rename?.id === row.executionId ? <form className="agent-rename" onSubmit={e => { e.preventDefault(); finishRename() }}><input autoFocus aria-label="Conversation name" value={rename.title} onChange={e => setRename({ ...rename, title: e.target.value })} onBlur={finishRename} /></form> : <button className="agent-thread-open" aria-current={selected === row.meta.id ? "page" : undefined} aria-label={`${threadTitle(row)} · ${row.agentName} · ${statusOf(row)}`} title={`${threadTitle(row)} · ${row.agentName} · ${statusOf(row)} · ${hostLabel(row.meta.hostKey)} · ${row.meta.folder}`} onClick={() => selectThread(row)}><span className="agent-thread-provider" title={row.agentName}><AgentProviderMark id={row.agentId} size={14} /></span><span className="agent-thread-title">{threadTitle(row)}</span><span className={`agent-thread-indicator ${row.pendingPermission || row.pendingInput ? "attention" : ["error", "submissionUnknown"].includes(row.state) ? "error" : row.turnActive ? "working" : row.meta.pinned ? "pinned" : "idle"}`} aria-hidden="true">{row.meta.pinned ? <AgentIcon name="pin" size={11} /> : <span />}</span>{row.pendingPermission || row.pendingInput ? <span className="agent-attention-label">Needs you</span> : ["error", "submissionUnknown"].includes(row.state) ? <span className="agent-attention-label is-error">{statusOf(row)}</span> : <time className="agent-thread-time" dateTime={new Date(row.meta.activityAt).toISOString()}>{relativeActivity(row.meta.activityAt)}</time>}</button>}
                <button className="agent-icon-button agent-thread-more" aria-label={`Actions for ${threadTitle(row)}`} aria-haspopup="menu" aria-expanded={menu === row.executionId} onClick={() => setMenu(menu === row.executionId ? null : row.executionId)}><AgentIcon name="more" size={14} /></button>
                {menu === row.executionId && <AgentMenu root={surface.current}><button role="menuitem" onClick={() => { setRename({ id: row.executionId, title: threadTitle(row) }); setMenu(null) }}><AgentIcon name="edit" />Rename</button><button role="menuitem" onClick={() => { updateThreadMeta(row.executionId, { pinned: !row.meta.pinned }); setMenu(null) }}><AgentIcon name="pin" />{row.meta.pinned ? "Unpin" : "Pin"}</button><button role="menuitem" onClick={() => moveThread(row, -1)}>Move up</button><button role="menuitem" onClick={() => moveThread(row, 1)}>Move down</button><hr /><button role="menuitem" disabled={row.turnActive} onClick={() => archiveThread(row)}><AgentIcon name="archive" />{row.meta.archivedAt ? "Restore" : "Archive"}</button><button role="menuitem" className="is-destructive" onClick={() => { setDeleting(row); setMenu(null) }}><AgentIcon name="trash" />Delete</button></AgentMenu>}
              </div>)}{prefs.drafts[key] && <button className="agent-empty-folder" onClick={() => newThread(p)}><AgentIcon name="edit" size={12} />Continue draft</button>}</div>}
            </div>
          })}
          {!sortedProjects.length && <div className="agent-sidebar-empty"><p>{query ? "No matching conversations." : archived ? "No archived conversations." : "Add a project to keep related conversations together."}</p>{!query && !archived && <button onClick={chooseFolder}><AgentIcon name="plus" size={14} />Add a project</button>}</div>}
        </nav>
        <footer className="agent-sidebar-footer">
          <button className="agent-sidebar-settings" aria-label="Agent settings" onClick={() => { setView("settings"); setSelected(null); setSidebar(false); setMenu(null) }}><AgentIcon name="settings" size={16} /><span>Settings</span></button>
          <button className="agent-icon-button agent-thread-more" aria-label="Workspace options" title="Workspace options" aria-haspopup="menu" aria-expanded={menu === "sidebar:more"} onClick={() => setMenu(menu === "sidebar:more" ? null : "sidebar:more")}><AgentIcon name="more" size={17} /></button>
          {storage.error && <div className="agent-storage-status has-error" title={`${savedStatus} · ${storage.path}`} role="status"><span className="agent-status-dot attention" /><span>{savedStatus}</span></div>}
        </footer>
      </div>
      {menu === "sidebar:view" && <AgentMenu root={surface.current} role="dialog" label="View options" className="agent-view-menu"><label>Sort conversations<select aria-label="Sort projects and conversations" value={prefs.sort} onChange={event => { setPrefs(old => ({ ...old, sort: event.target.value as typeof old.sort })); setMenu(null) }}><option value="recent">Recent</option><option value="name">A–Z</option><option value="manual">Manual</option></select></label></AgentMenu>}
      {menu === "sidebar:more" && <AgentMenu root={surface.current}><button role="menuitem" onClick={() => { setArchived(!archived); home() }}><AgentIcon name="archive" />{archived ? "All conversations" : "Archived"}</button><button role="menuitem" onClick={() => { setView("settings"); setSelected(null); setSidebar(false); setMenu(null) }}><AgentIcon name="settings" />Agent settings</button><button role="menuitem" onClick={onClose}><AgentIcon name="panel" />Back to workspace</button></AgentMenu>}
    </aside>
    <main className={`agent-main ${review && current ? "has-review" : ""}`} inert={sidebarOverlay || dialogOpen}>
      <div className="agent-sr-only" role="status" aria-atomic="true">{current?.pendingPermission ? `Approval needed: ${current.pendingPermission.title}` : current?.pendingInput ? `Agent question: ${current.pendingInput.title}` : ""}</div>
      <header className="agent-topbar" data-tauri-drag-region><div className="agent-breadcrumb"><button className="agent-icon-button agent-mobile-menu" aria-label="Toggle projects" aria-expanded={sidebarOverlay} onClick={() => sidebarOverlay ? toggleProjects() : revealProjects()}><AgentIcon name="panel" /></button>{current ? <AgentProviderMark id={current.agentId} size={18} /> : <AgentIcon name="chat" size={17} />}<button aria-label="Conversation home" onClick={home}>{current || archived ? "Conversations" : "New conversation"}</button>{context && <><AgentIcon name="chevron" size={12} /><button onClick={() => openProject(context)} title={`${hostLabel(context.host)} · ${context.folder}`}>{projectName}</button></>}{current && <><AgentIcon name="chevron" size={12} /><strong>{threadTitle(current)}</strong></>}{view === "settings" && <strong>Settings</strong>}</div>
        <div className="agent-topbar-actions">
          {current && <>
            <span className={`agent-status ${current.pendingPermission || current.pendingInput ? "is-attention" : ["error", "submissionUnknown"].includes(current.state) ? "is-error" : current.turnActive ? "is-working" : ""}`} role="status"><span className={`agent-status-dot ${current.pendingPermission || current.pendingInput ? "attention" : ["error", "submissionUnknown"].includes(current.state) ? "error" : current.turnActive ? "working" : ""}`} />{statusOf(current)}</span>
            <button className="agent-icon-button" aria-label="Find a message" title="Find a message" onClick={() => { setTimelineQuery(""); setTimelineOpen(true) }}><AgentIcon name="search" /></button>
            <button className={`agent-review-toggle ${review ? "is-active" : ""}`} aria-label="Review changes" aria-expanded={review} onClick={() => setReview(!review)}><AgentIcon name="changes" size={16} /><span>Changes</span>{changeCount.reportedFiles > 0 && <small>{changeCount.reportedFiles}</small>}</button>
          </>}
          {onOpenTerminal && (!context || context.host === host) && <button className="agent-icon-button" aria-label="Open terminal" title="Open terminal" onClick={onOpenTerminal}><AgentIcon name="terminal" /></button>}
          <button className="agent-icon-button" aria-label="Close agent workspace" title="Close agent workspace" onClick={onClose}><AgentIcon name="close" /></button>
        </div>
      </header>
      {(storage.error || storage.warnings.length > 0) && <div className="agent-storage-notice" role="alert"><span>{storage.error || storage.warnings[0]}</span>{storage.error && <button className="agent-button" onClick={() => { if (!hydrated) void hydrate(); else void flushAgentSaves() }}>{hydrated ? "Retry saving" : "Retry opening history"}</button>}</div>}
      <div className="agent-workbody">
      <div className={`agent-chat ${startScreen ? "is-launch" : ""} ${startScreen && recent.length ? "has-recents" : ""}`}>
      {view === "settings" ? <section className="agent-setup">
        <div className="agent-settings-heading"><h1>Agent settings</h1><p>Use the coding agents already installed on your server.</p></div>
        <label className="agent-field">Server<select aria-label="Settings server" value={host} onChange={e => selectHost(e.target.value)}><option value="">Choose a server</option>{hosts.map(s => <option key={hostKey(s)} value={hostKey(s)}>{s.name} · {s.username}@{s.host}</option>)}</select></label>
        {session && connectionNotice}
        <div className="agent-settings-list">{AGENTS.map(provider => {
          const info = discovery.agents.find(row => row.agentId === provider.id)
          return <details className="agent-provider-setting" key={provider.id}><summary><span className="agent-provider-logo"><AgentProviderMark id={provider.id} size={23} /></span><span><strong>{provider.label}</strong><small>{info?.installed ? info.available ? info.runtime === "acp" ? "Installed · ACP connection" : "Installed · native connection" : info.message || "Integration unavailable" : discovery.checking ? "Checking installation…" : info ? "Not found" : "Select a server to check"}</small></span><AgentIcon name="chevron" size={14} /></summary><div className="agent-provider-details"><p>{provider.note}</p><label className="agent-field">Executable path<input aria-label={`${provider.label} executable path`} disabled={!host} value={prefs.executables[host]?.[provider.id] || ""} placeholder={info?.executable || provider.executable} onChange={e => setPrefs(old => ({ ...old, executables: { ...old.executables, [host]: { ...old.executables[host], [provider.id]: e.target.value } } }))} /></label>{!info?.installed && <><span>Install on the server</span><code className="agent-install-command">{provider.installCommand}</code></>}<span>Sign in on the server</span><code className="agent-install-command">{provider.loginCommand}</code></div></details>
        })}</div>
        <div className="agent-inline-actions"><button className="agent-button" disabled={!host || !connected || discovery.checking} onClick={() => void check()}><AgentIcon name="refresh" />{discovery.checking ? "Checking…" : "Refresh"}</button><button className="agent-button" onClick={home}>Back to conversations</button></div>
        {discovery.error && <p className="agent-error" role="alert">{discovery.error}</p>}
        <div className="agent-local-settings"><h2>History on this device</h2><p>Conversations and drafts stay available when your server is offline.</p><code>{storage.path || "Opening local storage…"}</code></div>
      </section> : <>
        <div ref={scroll.viewport} className="agent-conversation" tabIndex={0} aria-label="Conversation" onScroll={scroll.onScroll} onWheel={scroll.onWheel}>
          <div ref={scroll.content} className="agent-message-list">
            {current ? <>{firstItem > 0 && <div className="agent-history-page"><button onClick={loadEarlier}>Load earlier activity <span>{firstItem} more</span></button><button className="agent-link-button" onClick={() => { setTimelineQuery(""); setTimelineOpen(true) }}>Find a message</button></div>}<AgentTimeline items={visibleItems} agentName={current.agentName} agentId={current.agentId} plan={plan} actions={historyActions} requests={requestActions} turnActive={turnActive} />{!items.length && <div className="agent-thread-empty"><AgentProviderMark id={current.agentId} size={34} /><h2>{current.state === "connecting" ? `Connecting ${current.agentName}…` : idle(current) ? `${current.agentName} is ready` : current.state === "saved" ? "Saved conversation" : "Agent connection unavailable"}</h2><p>{current.state === "connecting" ? "Loading the models and commands from your server." : idle(current) ? "Send a message to get started." : "Your conversation remains available on this device."}</p></div>}{turnActive && !hasActiveReasoning && <div className="agent-working" role="status"><AgentProviderMark id={current.agentId} size={16} /><span className="agent-status-dot working" />{current.lastError?.includes("Cancellation") ? "Stopping…" : "Working…"}</div>}{changes.length > 0 && <AgentChangeSummary changes={changes} open={() => setReview(true)} />}</>
              : startScreen ? <div className="agent-welcome"><h1>What will you <em>build?</em></h1>{context && <button className="agent-welcome-project" title={`${hostLabel(context.host)} · ${context.folder}`} onClick={() => setProjectChoices(!projectChoices)}><AgentIcon name="folder" size={16} />{projectName}<AgentIcon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} /></button>}</div>
                : <div className="agent-home"><div className="agent-home-heading"><h1>Archived conversations</h1><p>Your previous work, saved on this device.</p></div>{recent.length ? <div className="agent-recents">{recent.map(row => <button key={row.meta.id} className="agent-recent" onClick={() => selectThread(row)}><AgentProviderMark id={row.agentId} size={18} /><span><strong>{threadTitle(row)}</strong><small>{folderName(row.meta.folder)} · {row.agentName}</small></span><time>{relativeActivity(row.meta.activityAt)}</time><AgentIcon name="chevron" size={13} /></button>)}</div> : <p className="agent-muted">Nothing archived yet.</p>}</div>}
          </div>
        </div>
        {showComposer && <div ref={composerDock} className={`agent-composer-area${startScreen ? " is-compact" : ""}${composerCollapsed ? " is-collapsed" : ""}`}>
          {!scroll.atLatest && current && !activeRequestItem && <button className="agent-jump" onClick={scroll.follow}>Latest activity <AgentIcon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} /></button>}
          {activeRequestItem && current && <button className={`agent-request-jump ${activeRequestKind === "permission" ? "is-approval" : "is-question"}`} onClick={() => {
            if (matchMedia("(max-height: 560px)").matches) setExpandedRequest(activeRequestItem.id)
            else { findMessage(activeRequestItem.id); requestAnimationFrame(() => surface.current?.querySelector<HTMLElement>(`[data-timeline-id="${CSS.escape(activeRequestItem.id)}"] .agent-request-expand`)?.focus({ preventScroll: true })) }
          }}><span className="agent-status-dot attention" />{activeRequestKind === "permission" ? "Approval needed" : "Your answer is needed"}<span>Review request</span><AgentIcon name="chevron" size={13} /></button>}
           {current?.persistent && ["saved", "detached", "connecting"].includes(current.state) ? <div className="agent-saved-notice" role="status"><span><AgentIcon name="refresh" size={15} />{restoring || !connectedHere ? "Connecting to the server to restore this agent…" : "Agent execution is kept on your server"}</span></div> : current?.state === "saved" ? <div className="agent-saved-notice" role="status"><span><AgentIcon name={restoring ? "refresh" : "check"} size={15} />{restoring ? "Restoring this conversation from the server…" : canResumeAgentThread(current) ? connectedHere ? "Resuming the saved provider session…" : "Connecting to the saved server…" : "Saved on this device"}</span></div> : null}
          {session && connectionNotice}
           {(error || current?.lastError && ["error", "submissionUnknown"].includes(current.state)) && <div className="agent-error" role="alert"><span>{error || current?.lastError}</span></div>}
          {!current && preparing && <div className={`agent-preparation ${preparation.error || prepared?.state === "error" ? "has-error" : ""}`} role="status"><span className={`agent-status-dot ${preparation.error || prepared?.state === "error" ? "attention" : preparation.ready ? "connected" : "working"}`} /><span>{preparation.error || (prepared?.state === "error" ? prepared.lastError : preparation.ready ? `${definition.label} connected · choose your model` : `Connecting ${definition.label} and loading models…`)}</span>{(preparation.error || prepared?.state === "error") && <button type="button" onClick={() => preparation.retry()}>Retry connection</button>}</div>}
          {projectChoices && <div ref={projectPopover} className="agent-context-choices" role="dialog" aria-label="Choose a project"><div><strong>Choose a project</strong><button type="button" className="agent-icon-button" aria-label="Close project choices" onClick={() => setProjectChoices(false)}><AgentIcon name="close" size={14} /></button></div>{projects.map(p => <button type="button" key={projectKey(p)} className="agent-project-choice" onClick={() => assignProject(p)}><AgentIcon name="folder" size={14} /><span>{p.name || folderName(p.folder)}<small>{hostLabel(p.host)} · {p.folder}</small></span></button>)}<button type="button" className="agent-link-button" onClick={() => { setProjectChoices(false); chooseFolder() }}>Add another project</button></div>}
          {current && (current.todos?.items.length || 0) > 0 && <div className={`agent-todos-dock${todosOpen ? " is-expanded" : ""}`}><AgentTodos todos={current.todos} expanded={todosOpen} expand={() => setTodosOpen(true)} collapse={() => setTodosOpen(false)} /></div>}
          <form className={`agent-composer${composerCollapsed ? " is-collapsed" : ""}`} onFocusCapture={e => {
            if ((e.target as HTMLElement).tagName === "TEXTAREA") setComposerExpanded(true)
          }} onBlurCapture={e => {
            if (composerDock.current?.contains(e.relatedTarget as Node | null)) return
            setComposerExpanded(false)
            setCommandOpen(false)
            setModelMenu(null)
          }} onClick={e => {
            if (!composerCollapsed || (e.target as HTMLElement).closest("button, a, input, select, textarea, [role=button]")) return
            textarea.current?.focus({ preventScroll: true })
          }} onSubmit={e => { e.preventDefault(); void send() }}>
            {commandOpen && <CommandPicker commands={commands} query={commandQuery} onQuery={setCommandQuery} onSelect={chooseCommand} onClose={() => { setCommandOpen(false); textarea.current?.focus() }} loading={catalogBusy || preparing && !preparation.ready && !preparation.error} error={catalogError || preparation.error} refresh={() => void refreshCatalog()} />}
            <textarea ref={textarea} aria-label="Message agent" aria-description="Enter to send. Shift+Enter for a new line. Type / for commands." rows={2} placeholder={current ? "Ask for a change or a follow-up…" : "Describe a task, ask a question, or just start building…"} value={draft} onChange={e => { setDraft(e.target.value); if (e.target.value === "/" || e.target.value === "@") { setCommandQuery(e.target.value === "@" ? "skill:" : ""); setCommandOpen(true) } }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
            <div className="agent-composer-toolbar">
              <div className="agent-composer-controls">
                {!current ? <ConfigPicker option={providerOption} icon={<AgentProviderMark id={agentId} size={20} />} disabled={busy || configBusy} change={(_, value) => setPrefs(old => ({ ...old, agent: String(value) }))} /> : <span className="agent-composer-provider"><AgentProviderMark id={current.agentId} size={20} />{current.agentName}</span>}
                 <AgentModelPicker key={activeAgent?.executionId || configurationKey} model={modelControl} reasoning={reasoningControl} open={modelMenu !== null} focusReasoning={modelMenu === "reasoning"} onOpenChange={open => { setModelMenu(open ? "model" : null); if (open) { setCommandOpen(false); setProjectChoices(false) } }} disabled={!connectedHere || !idle(activeAgent) || busy || configBusy || !current && !preparation.ready} disabledReason={current?.state === "saved" ? "Restore this conversation before changing its model" : current?.turnActive ? "Wait for the agent to finish before changing its model" : "Connect the agent to configure its model"} change={changeConfig} />
                {agentModeControl && <ConfigPicker key={`${activeAgent?.executionId}:${agentModeControl.id}`} option={agentModeControl} label="Agent" searchable={false} disabled={!connectedHere || !idle(activeAgent) || busy || configBusy || !current && !preparation.ready} change={changeSecondaryConfig} icon={<AgentIcon name="code" size={15} />} />}
              </div>
              <div className="agent-composer-actions"><button type="button" className="agent-icon-button" aria-label="Commands and skills" title="Commands and skills · Ctrl/⌘+P" aria-haspopup="listbox" aria-expanded={commandOpen} onClick={() => { setProjectChoices(false); setCommandQuery(""); setCommandOpen(!commandOpen) }}><AgentIcon name="command" /></button>{current?.turnActive ? <button className="agent-send agent-stop" type="button" aria-label="Stop agent" title="Stop agent" disabled={busy} onClick={() => void run(() => cancelAgentTurn(current.executionId))}><AgentIcon name="stop" size={14} /></button> : <button className="agent-send" type="submit" aria-label="Send message" title={canSend ? "Send message" : !context ? "Choose a project to send" : "Send message"} disabled={!canSend}><AgentIcon name="arrow" size={19} /></button>}</div>
            </div>
          </form>
          {configError && !extraControl && <p className="agent-model-error" role="alert">{configError}</p>}
          <div className="agent-composer-footnote">
            {context ? <div className="agent-context-line"><AgentIcon name="folder" size={13} /><span title={context.folder}>{context.folder}</span><small title={hostLabel(context.host)}>{hostLabel(context.host)}</small>{!current && <button type="button" data-agent-popover-trigger aria-label="Change project" title="Change project" aria-haspopup="dialog" aria-expanded={projectChoices} onClick={() => { setCommandOpen(false); setProjectChoices(!projectChoices) }}><AgentIcon name="chevron" size={11} /></button>}</div> : <button type="button" className="agent-choose-project" data-agent-popover-trigger aria-haspopup="dialog" aria-expanded={projectChoices || folderOpen} onClick={() => { setCommandOpen(false); if (projects.length) setProjectChoices(!projectChoices); else chooseFolder() }}><AgentIcon name="folder" size={14} /><span>Choose project</span><AgentIcon name="chevron" size={11} style={{ transform: "rotate(90deg)" }} /></button>}
            {composerNotice && <span className="agent-composer-status" role="status">{composerNotice}</span>}
          </div>
        </div>}
        {startScreen && <div className="agent-launch-extras"><div className="agent-starters">{promptStarters.map(starter => <button key={starter.label} disabled={!!draft.trim() || busy} onClick={() => useStarter(starter.prompt)}><span>{starter.label}</span></button>)}</div>{recent.length > 0 && <section className="agent-recents"><div className="agent-section-label"><span>Recent conversations</span><button className="agent-link-button" onClick={() => revealProjects(true)}>View all {recent.length} conversations <AgentIcon name="chevron" size={12} /></button></div>{recent.slice(0, 3).map(row => <button key={row.meta.id} className="agent-recent" onClick={() => selectThread(row)}><span><strong>{threadTitle(row)}</strong><small>{folderName(row.meta.folder)} · {row.agentName}</small></span><time>{relativeActivity(row.meta.activityAt)}</time><AgentIcon name="chevron" size={13} /></button>)}</section>}</div>}
      </>}
      </div>
      {review && current && <><button className="agent-review-scrim" aria-label="Close changes panel" onClick={() => setReview(false)} /><AgentChanges key={current.meta.id} changes={changes} close={() => setReview(false)} /></>}
      </div>
      {(undo || feedback) && <div className="agent-toast" role="status">{undo ? `Conversation ${undo.at ? "restored" : "archived"}` : feedback}{undo && <button onClick={() => { updateThreadMeta(undo.id, { archivedAt: undo.at }); setUndo(null) }}>Undo</button>}<button className="agent-icon-button" aria-label="Dismiss notification" onClick={() => { setUndo(null); setFeedback("") }}><AgentIcon name="close" size={13} /></button></div>}
    </main>
    {expandedItem && <div className="agent-confirm-backdrop agent-request-backdrop"><AgentRequest key={expandedItem.id} item={expandedItem} actions={requestActions} expanded /></div>}
    {extraControl && <div className="agent-confirm-backdrop"><section className="agent-modal agent-config-dialog" role="dialog" aria-modal="true" aria-label={fields.find(option => option.id === extraControl)?.name || "Agent control"}><div className="agent-modal-heading"><h2>{fields.find(option => option.id === extraControl)?.name || "Agent control"}</h2><button className="agent-icon-button" aria-label="Close agent control" onClick={() => setExtraControl(null)}><AgentIcon name="close" /></button></div>{fields.filter(option => option.id === extraControl).map(option => <div key={option.id}>{option.description && <p>{option.description}</p>}<ConfigPicker option={option} disabled={!connectedHere || !idle(activeAgent) || configBusy} change={changeSecondaryConfig} /></div>)}{configError && <p className="agent-model-error" role="alert">{configError}</p>}</section></div>}
    {historyAction && current && <div className="agent-confirm-backdrop"><section className="agent-modal agent-history-confirm" role="dialog" aria-modal="true" aria-labelledby="agent-history-title"><h2 id="agent-history-title">{historyAction.retry ? "Retry this message?" : "Revert to this message?"}</h2><p>{historyAction.retry ? "Return to before this message and send it again with the currently selected model." : "Return to before this message. Its replies and later messages will leave the active conversation."}</p><blockquote>{historyAction.message.text.slice(0, 240)}{historyAction.message.text.length > 240 ? "…" : ""}</blockquote><p>Project files stay as they are. {current.agentId === "pi" ? "Pi continues from a fork at this point." : "This updates the agent’s conversation history."}</p>{error && <p className="agent-error" role="alert">{error}</p>}<div className="agent-inline-actions"><button className="agent-button" disabled={busy} onClick={() => setHistoryAction(null)}>Cancel</button><button className="agent-primary" disabled={busy || !connectedHere || !canChangeAgentHistory(current, historyAction.message.messageId || "", historyAction.retry)} onClick={() => void applyHistoryAction()}>{busy ? "Updating history…" : historyAction.retry ? "Retry message" : "Revert conversation"}</button></div></section></div>}
    {timelineOpen && <div className="agent-confirm-backdrop"><section className="agent-modal" role="dialog" aria-modal="true" aria-label="Find a message"><div className="agent-modal-heading"><h2>Find a message</h2><button className="agent-icon-button" aria-label="Close message search" onClick={() => setTimelineOpen(false)}><AgentIcon name="close" /></button></div><label className="agent-field">Search this conversation<input autoFocus value={timelineQuery} onChange={e => setTimelineQuery(e.target.value)} /></label><div className="agent-timeline-results">{items.filter(item => ["user", "assistant"].includes(item.kind) && item.text.toLowerCase().includes(timelineQuery.toLowerCase())).map(item => <button key={item.id} onClick={() => findMessage(item.id)}><small>{item.kind === "user" ? "You" : current?.agentName}</small><span>{item.text.slice(0, 160)}</span></button>)}</div></section></div>}
    {folderOpen && <div className="agent-confirm-backdrop"><section className="agent-modal agent-folder-picker" role="dialog" aria-modal="true" aria-labelledby="agent-project-title"><div className="agent-modal-heading"><div><h2 id="agent-project-title">Choose a project</h2><p>A folder on the server where your agent will work.</p></div><button className="agent-icon-button" aria-label="Close project picker" onClick={closeFolder}><AgentIcon name="close" /></button></div>
      {addingServer ? <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const port = Number(data.get("port")), hostname = String(data.get("hostname") || "").trim(), username = String(data.get("username") || "").trim(); if (!hostname || !username || !Number.isInteger(port) || port < 1 || port > 65535) return; const key = JSON.stringify([hostname.toLowerCase(), port, username]); const profile = sessionForHost(key, hosts); folderOperation.current++; setFolderHost(key); if (profile) onSelectHost?.({ ...profile, authMethod: data.get("auth") === "key" ? "key" : "ask" }); setAddingServer(false) }}><label className="agent-field">Host<input required name="hostname" placeholder="server.example.com" /></label><div className="agent-server-fields"><label className="agent-field">Username<input required name="username" placeholder="dev" /></label><label className="agent-field">Port<input required type="number" min={1} max={65535} name="port" defaultValue="22" /></label></div><label className="agent-field">Authentication<select name="auth"><option value="ask">Password or saved credential</option><option value="key">Private key</option></select></label><div className="agent-inline-actions"><button className="agent-primary">Use this server</button><button type="button" className="agent-button" onClick={() => setAddingServer(false)}>Back</button></div></form> : <form onSubmit={e => { e.preventDefault(); void openFolder() }}><label className="agent-field">Server<select aria-label="Project server" value={folderHost} disabled={busy} onChange={e => { folderOperation.current++; setFolderHost(e.target.value); if (e.target.value) selectHost(e.target.value) }}><option value="">Choose a server</option>{hosts.map(s => <option key={hostKey(s)} value={hostKey(s)}>{s.name} · {s.username}@{s.host}</option>)}</select></label><button type="button" className="agent-link-button" disabled={busy} onClick={() => setAddingServer(true)}>Add a server</button><label className="agent-field">Remote project folder<input required autoComplete="off" aria-label="Remote project folder" disabled={busy} value={folderPath} onChange={e => { folderOperation.current++; setFolderPath(e.target.value) }} placeholder="~/projects/my-app" /></label>{folderHost === host && connectionNotice}{error && <p className="agent-error" role="alert">{error}</p>}<div className="agent-inline-actions"><button className="agent-primary" disabled={busy || !connected || folderHost !== host || !folderPath.trim()}>Open folder</button><button type="button" className="agent-button" onClick={closeFolder}>Cancel</button></div></form>}
    </section></div>}
    {deleting && <div className="agent-confirm-backdrop"><section className="agent-modal agent-confirm" role="alertdialog" aria-modal="true" aria-labelledby="agent-delete-title"><h2 id="agent-delete-title">Delete this conversation?</h2><p>“{threadTitle(deleting)}” will be removed from Still. Project files, terminal sessions, and the agent’s own saved history are kept.</p>{deleting.turnActive && <p>Stop the agent before deleting this conversation.</p>}{error && <p className="agent-error" role="alert">{error}</p>}<div className="agent-inline-actions"><button className="agent-button" onClick={() => setDeleting(null)}>Cancel</button>{deleting.turnActive ? <button className="agent-primary" disabled={busy} onClick={() => void run(async () => { await cancelAgentTurn(deleting.executionId); setDeleting(null) })}>Stop agent</button> : <button className="agent-danger" disabled={busy} onClick={() => void run(async () => { await deleteAgentThread(deleting.executionId); if (selected === deleting.meta.id) home(); setDeleting(null) })}>Delete conversation</button>}</div></section></div>}
  </section>
}
