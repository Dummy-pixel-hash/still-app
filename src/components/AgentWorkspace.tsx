/* THESIS: A real coding workspace: choose a project, make a request, inspect its changes.
 * OWN-WORLD: Neutral black, a horizontal red particle horizon, frosted writing surfaces,
 * identifiable providers, syntax-colored code and honest red/green file changes.
 * STORY: Start a task, follow the conversation, then switch to a focused changes view.
 * FIRST VIEWPORT: 272px collapsible project navigation, 54px work header, a centered
 * launch area that becomes a 960px transcript and floating composer. Changes replace chat.
 * FORM: User-pinned T3 Code/Codex desktop canon, grounded in their actual screenshots.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AGENTS, type AgentAvailability, type AgentCatalog, type AgentCommand, type AgentLaunchOptions, type CustomAgent } from "../agents/types"
import { conversation } from "../agents/transcript"
import { agentsForHost, customLaunchOptions } from "../agents/customAgents"
import CustomAgentSetup from "./CustomAgentSetup"
import { attachmentId, loadAttachmentFile, removeAttachmentFile, saveAttachmentFile, validateAttachments, type AgentDraftAttachment } from "../agents/attachments"
import { agentServerProfile, folderName, hostKey, hostLabel, normalizeFolder, projectKey, readLibraryPreferences, sessionForHost, type AgentLibraryPreferences, type AgentProject } from "../agents/workspace"
import { useConversationScroll } from "../agents/useConversationScroll"
import { useComposerOverlay } from "../agents/useComposerOverlay"
import { useComposerMotion } from "../agents/useComposerMotion"
import { useAgentListMotion } from "../agents/useAgentListMotion"
import { useAgentPopover } from "../agents/useAgentPopover"
import { usePreparedAgent } from "../agents/usePreparedAgent"
import { commandInventory } from "../agents/commands"
import { canChangeAgentHistory, changeAgentHistory, canResumeAgentThread, cancelAgentTurn, claimAgentThreads, clearAgentDraft, deleteAgentThread, loadAgentThreads, reconcileAgentRequest, reconcileAgentThread, refreshAgentCommands, refreshAgentThread, respondAgentInput, respondAgentPermission, resumeAgentThread, sendAgentMessage, setAgentConfig, subscribeRemoteAgent, threadTitle, updateThreadMeta, useAgentThreads, type AgentThreadRow } from "../session/agentThreads"
import { agentDiscoverySelectionKey, discoverAgents, useAgentDiscovery } from "../session/agentDiscovery"
import { flushAgentSaves, saveAgentWorkspace, useAgentStorage } from "../session/agentStorage"
import { nativeBridge, readClipboardImageFile } from "../bridge/nativeBridge"
import type { Session } from "../types"
import AgentIcon from "./AgentIcon"
import AgentMenu from "./AgentMenu"
import AgentProviderMark, { StillAgentMark } from "./AgentProviderMark"
import AgentChanges, { AgentChangeSummary } from "./AgentChanges"
import AgentRepositoryChanges from "./AgentRepositoryChanges"
import { conversationChanges } from "../agents/changes"
import { CommandPicker, ConfigPicker, modeOption, reasoningOption } from "./AgentControls"
import AgentModelPicker from "./AgentModelPicker"
import AgentReasoningBars from "./AgentReasoningBars"
import AgentAurora from "./AgentAurora"
import { AgentTimeline } from "./AgentTimeline"
import AgentTodos from "./AgentTodos"
import AgentSubagents from "./AgentSubagents"
import AgentAttachments from "./AgentAttachments"
import AgentRequest, { requestOutcomeLabel, type AgentRequestActions } from "./AgentRequest"
import { requestKey, questionFields } from "../agents/requests"
import AgentCapabilities, { agentProviderTransportLabel } from "./AgentCapabilities"
import { useAgentGit } from "../session/agentGit"
import type { TranscriptItem } from "../agents/transcript"
import "../styles/agent-workspace.css"
import "../styles/agent-materials.css"
import "../styles/agent-changes.css"

type Props = {
  presentation?: "desktop" | "mobile"
  initialConversationId?: string
  initialView?: "draft" | "settings"
  initialProject?: AgentProject
  initialProjectPicker?: boolean
  closing?: boolean
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
  onCheck: (agentId?: string, executable?: string, customAgent?: CustomAgent, testConnection?: boolean) => Promise<AgentAvailability[]>
  onCatalog?: (agentId: string, cwd: string, executable?: string) => Promise<AgentCatalog>
  onResolveFolder?: (cwd: string) => Promise<string>
}
const messageOf = (e: unknown) => e && typeof e === "object" && "message" in e ? String(e.message) : String(e || "Operation failed")
const idle = (row: AgentThreadRow | null) => !!row && !row.recoveryReason && !row.turnActive && !row.pendingPermission && !row.pendingInput && !row.meta.submissionUnknown && ["working", "complete", "cancelled", "error"].includes(row.state)
const statusOf = (row: AgentThreadRow) => row.meta.subagentPrepared ? "Prepared" : row.state === "detached" ? "On server" : row.pendingPermission || row.pendingInput ? "Needs you" : row.state === "saved" ? "Saved" : row.state === "connecting" ? "Connecting" : row.state === "rewinding" ? "Reverting" : row.state === "submissionUnknown" ? "Uncertain" : row.state === "error" ? row.turnActive ? "Connection issue · still running" : "Turn failed" : row.turnActive ? "Working" : "Ready"
const subagentInFlight = (row: AgentThreadRow) => row.turnActive || ["connecting", "working", "inputRequired", "detached", "submissionUnknown", "rewinding"].includes(row.state)
const historyWindows = new Map<string, string>()
async function subagentOperationId(parentExecutionId: string, requestId: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${parentExecutionId}:${requestId}`)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")
}
function subagentSettings(row: AgentThreadRow) {
  const config = (kinds: string[], ids: string[]) => row.configOptions.find(option => kinds.includes(option.category || "") || ids.includes(option.id))
  const choices = (option: AgentThreadRow["configOptions"][number] | undefined) => (option?.options || []).flatMap(item => "value" in item ? [item] : item.options).map(item => ({ id: item.value, name: item.name }))
  const model = config(["model"], ["model"]), effort = config(["thought_level", "reasoning", "effort", "variant", "variants"], []), mode = config(["mode", "agent", "agent_mode"], [])
  const item = (option: typeof model) => option ? { id: option.id, name: option.name, current: option.currentValue, choices: choices(option) } : undefined
  return { model: item(model), effort: item(effort), mode: item(mode) }
}
const promptStarters = [
  { icon: "code" as const, label: "Build a feature", prompt: "Help me build a feature in this project. First, look at the structure and ask me what I want to add." },
  { icon: "search" as const, label: "Explore the code", prompt: "Explore this project and explain how the important pieces fit together. Show me where to start." },
  { icon: "check" as const, label: "Review changes", prompt: "Review the changes in this project for bugs, regressions, and missing tests. Explain the most important findings." },
]
function relativeActivity(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000))
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}
function markdownCode(value: string) { return `\`${value.replace(/`/g, "ˋ")}\`` }

export default function AgentWorkspace({ presentation = "desktop", initialConversationId, initialView, initialProject, initialProjectPicker = false, closing = false, session, sessions = [], onSelectHost, onReattach, transportId, connected = true, connectionNotice, onClose, onOpenTerminal, onStart, onCheck, onCatalog, onResolveFolder }: Props) {
  const mobile = presentation === "mobile"
  const allThreads = useAgentThreads(), storage = useAgentStorage()
  const [prefs, setPrefs] = useState<AgentLibraryPreferences>(() => readLibraryPreferences())
  const [hydrated, setHydrated] = useState(false)
  const [customSetup, setCustomSetup] = useState<CustomAgent | null>(null)
  const [removingCustom, setRemovingCustom] = useState<CustomAgent | null>(null)
  const [selected, setSelected] = useState<string | null>(initialConversationId || null)
  const [parentReturnId, setParentReturnId] = useState<string | null>(null)
  const [project, setProject] = useState<AgentProject | null>(initialProject || null)
  const [view, setView] = useState<"home" | "draft" | "project" | "settings">(initialView || "home")
  const [sidebar, setSidebar] = useState(false), [query, setQuery] = useState(""), [archived, setArchived] = useState(false)
  const [narrowNavigation, setNarrowNavigation] = useState(() => matchMedia("(max-width: 800px)").matches)
  const reviewReturnFocus = useRef<HTMLElement | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [rename, setRename] = useState<{ id: string; title: string; project?: AgentProject } | null>(null)
  const [deleting, setDeleting] = useState<AgentThreadRow | null>(null)
  const [undo, setUndo] = useState<{ id: string; at?: number } | null>(null)
  const [busy, setBusy] = useState(false), [configBusy, setConfigBusy] = useState(false)
  const [attachmentProgress, setAttachmentProgress] = useState<Record<string, string>>({})
  const [attachmentError, setAttachmentError] = useState("")
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [composerExpanded, changeComposerExpanded] = useState(false)
  const [error, setError] = useState("")
  const [commandOpen, setCommandOpen] = useState(false), [commandQuery, setCommandQuery] = useState("")
  const [modelMenu, setModelMenu] = useState<"model" | null>(null)
  const [extraControl, setExtraControl] = useState<string | null>(null)
  const [configError, setConfigError] = useState("")
  const [restoring, setRestoring] = useState(false)
  const attachAttempt = useRef("")
  const resumeAttempt = useRef("")
  const [timelineOpen, setTimelineOpen] = useState(false), [timelineQuery, setTimelineQuery] = useState("")
  const [feedback, setFeedback] = useState("")
  const [review, setReview] = useState(false)
  const [reviewMode, setReviewMode] = useState<"repository" | "conversation">("repository")
  const [gitRefreshEpoch, setGitRefreshEpoch] = useState(0)
  const [todosOpen, setTodosOpen] = useState(false)
  const [agentDetailsOpen, setAgentDetailsOpen] = useState(false)
  const [historyAction, setHistoryAction] = useState<{ message: TranscriptItem; retry: boolean } | null>(null)
  const [folderOpen, setFolderOpen] = useState(initialProjectPicker), [folderHost, setFolderHost] = useState(""), [folderPath, setFolderPath] = useState("")
  const [projectChoices, setProjectChoices] = useState(false)
  const [addingServer, setAddingServer] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState(false), [catalogError, setCatalogError] = useState("")
  const [requestDrafts, setRequestDrafts] = useState<Record<string, Record<string, unknown>>>({})
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({})
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null)
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null)
  const requestOperations = useRef(new Set<string>())
  const subagentRequestOperations = useRef(new Set<string>())
  const subagentRequestQueue = useRef(Promise.resolve())
  const subagentGuidanceAttempts = useRef(new Set<string>())
  const [draftGeneration, setDraftGeneration] = useState(0)
  const [, updateHistoryWindow] = useState(0)
  const surface = useRef<HTMLElement>(null), textarea = useRef<HTMLTextAreaElement>(null), filePicker = useRef<HTMLInputElement>(null), search = useRef<HTMLInputElement>(null), timelineSearch = useRef<HTMLInputElement>(null)
  const sidebarToggle = useRef<HTMLButtonElement>(null)
  const navigationPanel = useRef<HTMLElement>(null)
  const projectPopover = useRef<HTMLDivElement>(null), agentDetailsRoot = useRef<HTMLDivElement>(null), returnFocus = useRef<HTMLElement | null>(null)
  useAgentPopover(projectPopover, projectChoices, "start", true)
  const navigation = useRef(0), mounted = useRef(true), prefsRef = useRef(prefs)
  const folderOperation = useRef(0)
  const callbacks = useRef({ onCheck, onCatalog, onStart }); callbacks.current = { onCheck, onCatalog, onStart }; prefsRef.current = prefs
  const host = session ? hostKey(session) : ""
  const agents = agentsForHost(host, prefs.customAgents)
  const customDiscoveryKey = JSON.stringify(prefs.customAgents[host] || [])
  const executableSelections = prefs.executables[host] || {}
  const discoverySelectionKey = agentDiscoverySelectionKey(transportId, executableSelections, agents.map(agent => agent.id), prefs.customAgents[host])
  const discovery = useAgentDiscovery(host, discoverySelectionKey)
  const discoveryCurrent = !discovery.stale && discovery.selectionKey === discoverySelectionKey
  const discoveryStatus = (info?: AgentAvailability) => {
    const status = info?.installed
      ? info.available ? info.agentId.startsWith("custom-") ? "Installed · connection not tested" : info.runtime === "acp" ? "Installed · ACP connection" : "Installed · native connection" : info.message || "Integration unavailable"
      : discovery.checking ? "Checking installation…" : info ? "Not found" : "Select a server to check"
    return discovery.stale && info ? `Cached · ${status}` : status
  }
  const libraryThreads = allThreads.filter(row => !row.meta.prepared || row.state === "saved" || !!row.meta.draft || row.transcript.some(event => event.type === "userMessage"))
  const current = libraryThreads.find(row => row.meta.id === selected) || null
  const parentThread = current?.meta.parentConversationId ? libraryThreads.find(row => row.meta.id === current.meta.parentConversationId) || null : null
  const isSubagent = !!current?.meta.parentConversationId
  const childThreads = current ? libraryThreads.filter(row => row.meta.parentConversationId === current.meta.id && !row.meta.archivedAt).sort((a, b) => b.meta.activityAt - a.meta.activityAt) : []
  const latestThreads = useRef(allThreads); latestThreads.current = allThreads
  const context = current ? { host: current.meta.hostKey, folder: current.meta.folder } : project
  const contextKey = context ? projectKey(context) : "unassigned"
  const connectedHere = !!context && context.host === host && connected
  useEffect(() => {
    const completed = new Set(allThreads.flatMap(row => row.transcript.filter(event => event.type === "subagentReply" && event.subagentRequest?.requestId).map(event => `${row.executionId}:${event.subagentRequest!.requestId}`)))
    for (const parent of allThreads) for (const event of parent.transcript) {
      if (event.type !== "subagentRequest" || !event.subagentRequest) continue
      const { requestId, input } = event.subagentRequest
      const operationKey = `${parent.executionId}:${requestId}`
      if (completed.has(operationKey)) continue
      if (subagentRequestOperations.current.has(operationKey)) continue
      subagentRequestOperations.current.add(operationKey)
      const task = subagentRequestQueue.current.then(async () => {
        const action = typeof input.action === "string" ? input.action : ""
        const childId = typeof input.childId === "string" ? input.childId : ""
        const currentRows = () => latestThreads.current
        const childRows = () => currentRows().filter(row => row.meta.parentConversationId === parent.meta.id)
        const detail = (row: AgentThreadRow) => ({ childId: row.meta.id, title: threadTitle(row), agentId: row.agentId, agentName: row.agentName, status: statusOf(row), settings: subagentSettings(row), prepared: !!row.meta.subagentPrepared, turnActive: row.turnActive, needsAttention: !!(row.pendingInput || row.pendingPermission), queuedGuidance: row.meta.subagentGuidance?.length || 0, guidancePaused: !!row.meta.subagentGuidancePaused, lastUpdate: row.transcript.filter(item => ["assistantMessage", "toolUpdate", "threadComplete", "threadError"].includes(item.type)).slice(-1)[0]?.text?.slice(0, 1000) || "" })
        const findChild = () => childRows().find(row => row.meta.id === childId)
        const createChild = async (agentId: string, title: string, operationId: string) => {
          const definition = agents.find(agent => agent.id === agentId)
          const support = discovery.agents.find(info => info.agentId === agentId)
          if (!definition || support?.available !== true) throw new Error("Choose an installed, available agent returned by still_subagents list.")
          if (childRows().filter(subagentInFlight).length >= 3) throw new Error("This parent already has three active subagents. Wait for one to finish before preparing another.")
          if (!connected || !transportId || host !== parent.meta.hostKey) throw new Error("Select and connect to the parent conversation's server before preparing a child.")
          const operationMap = parent.meta.subagentOperations || {}
          const conversationId = operationMap[operationId] || `subagent-${crypto.randomUUID()}`
          if (!operationMap[operationId]) updateThreadMeta(parent.executionId, { subagentOperations: { ...operationMap, [operationId]: conversationId } })
          let row = currentRows().find(candidate => candidate.meta.id === conversationId)
          if (!row) {
            const customAgent = customLaunchOptions(agentId, parent.meta.hostKey, prefsRef.current.customAgents)
            row = await callbacks.current.onStart(agentId, { cwd: parent.meta.folder, conversationId, parentConversationId: parent.meta.id, executable: prefsRef.current.executables[parent.meta.hostKey]?.[agentId], customAgent })
            updateThreadMeta(row.executionId, { title, titleSource: "agent", parentConversationId: parent.meta.id, subagentPrepared: true })
          } else if (row.meta.parentConversationId !== parent.meta.id || row.agentId !== agentId) throw new Error("That prepared conversation does not match this parent and agent.")
          return currentRows().find(candidate => candidate.meta.id === conversationId) || row
        }
        const applySetting = async (row: AgentThreadRow, key: "model" | "effort" | "mode", requested: unknown) => {
          if (requested === undefined) return row
          if (typeof requested !== "string" || !requested) throw new Error(`${key} must be a non-empty provider option ID.`)
          const description = subagentSettings(row)[key]
          if (!description) throw new Error(`This child provider does not expose a selectable ${key}. Prepared child ID: ${row.meta.id}. No task was submitted.`)
          if (!description.choices.some(option => option.id === requested)) throw new Error(`Unsupported ${key} ID "${requested}". Available choices: ${description.choices.map(option => `${option.name} (${option.id})`).join(", ") || "none"}. Prepared child ID: ${row.meta.id}. No task was submitted.`)
          if (description.current === requested) return row
          return setAgentConfig(row.executionId, description.id, requested)
        }
        let result: unknown
        if (parent.meta.parentConversationId) throw new Error("Subagents cannot create nested subagents.")
        if (action === "list") {
          if (host !== parent.meta.hostKey) throw new Error("Select the parent conversation's server to list agents installed for this project.")
          result = { agents: agents.map(agent => { const support = discovery.agents.find(info => info.agentId === agent.id); return { agentId: agent.id, name: agent.label, available: support?.available === true, reason: support?.available ? undefined : support?.message || "Not verified on this server" } }), children: childRows().map(detail), instruction: "Use prepare(agentId) to get that provider's exact model, effort, and mode IDs before selecting them in spawn. Only provider-advertised settings are valid." }
        } else if (action === "prepare") {
          const agentId = typeof input.agentId === "string" ? input.agentId : ""
          const title = typeof input.title === "string" ? input.title.trim().slice(0, 160) : `Prepared ${agents.find(agent => agent.id === agentId)?.label || "subagent"}`
          const operationId = await subagentOperationId(parent.executionId, requestId)
          const child = await createChild(agentId, title, operationId)
          result = { ...detail(child), settings: subagentSettings(child), note: "Provider session is prepared; no task has been submitted. Use spawn with this childId and any supported setting IDs." }
        } else if (action === "spawn") {
          const title = typeof input.title === "string" ? input.title.trim().slice(0, 160) : ""
          const task = typeof input.task === "string" ? input.task.trim() : ""
          if (!title || !task || task.length > 12000) throw new Error("Spawn requires a title and task of at most 12,000 characters.")
          let child = childId ? findChild() : undefined
          if (childId && (!child || !child.meta.subagentPrepared || child.transcript.some(item => item.type === "userMessage"))) throw new Error("spawn requires an unused prepared child from this parent. Use prepare first to discover settings.")
          if (child && typeof input.agentId === "string" && child.agentId !== input.agentId) throw new Error("The prepared child belongs to a different agent. Inspect the prepared child and retry without changing its agent.")
          if (!child) {
            const agentId = typeof input.agentId === "string" ? input.agentId : ""
            const operationId = await subagentOperationId(parent.executionId, requestId)
            child = await createChild(agentId, title, operationId)
          }
          if (child.meta.title !== title) updateThreadMeta(child.executionId, { title, titleSource: "agent" })
          child = await applySetting(child, "model", input.modelId)
          child = await applySetting(child, "effort", input.effort)
          child = await applySetting(child, "mode", input.modeId)
          if (!child.transcript.some(item => item.type === "userMessage")) await sendAgentMessage(child.executionId, task)
          updateThreadMeta(child.executionId, { subagentPrepared: false })
          result = { ...detail(child), status: "Started", note: "The child has its own conversation and shares the parent's project folder." }
        } else if (action === "inspect") {
          const child = findChild()
          if (!child) throw new Error("That child conversation does not belong to this parent.")
          result = detail(child)
        } else if (action === "guide") {
          const child = findChild()
          if (!child) throw new Error("That child conversation does not belong to this parent.")
          const message = typeof input.message === "string" ? input.message.trim() : ""
          if (!message || message.length > 4000) throw new Error("Guidance must be 1–4,000 characters.")
          const operationId = await subagentOperationId(parent.executionId, requestId)
          const messageId = `parent-guidance-${operationId}`
          if (child.transcript.some(item => item.type === "userMessage" && item.messageId === messageId)) {
            result = { childId, status: "Delivered", note: "This guidance was already accepted by the child." }
          } else {
            const queued = child.meta.subagentGuidance || []
            if (!queued.some(item => item.requestId === operationId)) updateThreadMeta(child.executionId, { subagentGuidance: [...queued, { requestId: operationId, messageId, text: message }], subagentGuidancePaused: false })
            result = { childId, status: "Queued", note: child.turnActive || child.pendingInput || child.pendingPermission ? "Will send at the next safe turn boundary. The child's current turn and user-owned permission requests are not interrupted." : "Saved and sending as the child's next turn." }
          }
        } else if (action === "cancel") {
          const child = findChild()
          if (!child) throw new Error("That child conversation does not belong to this parent.")
          updateThreadMeta(child.executionId, { subagentGuidancePaused: true })
          if (!subagentInFlight(child)) result = { childId, status: "Already idle", pausedGuidance: child.meta.subagentGuidance?.length || 0 }
          else {
            try { await cancelAgentTurn(child.executionId) }
            catch (error) { updateThreadMeta(child.executionId, { subagentGuidancePaused: false }); throw error }
            result = { childId, status: "Cancellation requested", pausedGuidance: child.meta.subagentGuidance?.length || 0, note: "Wait for the child's stopped/completed status before assuming work ended. Queued guidance is paused; existing file changes remain." }
          }
        } else if (action === "wait") {
          const timeout = Number.isSafeInteger(input.timeoutMs) ? Math.max(1000, Math.min(15000, Number(input.timeoutMs))) : 5000
          await new Promise(resolve => setTimeout(resolve, timeout))
          const child = findChild()
          if (!child) throw new Error("That child conversation does not belong to this parent.")
          result = detail(child)
        } else throw new Error("Unsupported subagent action.")
        await nativeBridge.agentSubagentReply(parent.executionId, requestId, result)
      })
      subagentRequestQueue.current = task.catch(() => {})
      void task.catch(error => { void nativeBridge.agentSubagentReply(parent.executionId, requestId, undefined, messageOf(error)).catch(() => { subagentRequestOperations.current.delete(operationKey) }); setError(messageOf(error)) })
    }
  }, [allThreads, agents, discovery.agents, host, connected, transportId])
  useEffect(() => {
    for (const row of allThreads) {
      const queue = row.meta.subagentGuidance || []
      if (!queue.length) continue
      const delivered = new Set(row.transcript.filter(event => event.type === "userMessage" && event.messageId).map(event => event.messageId))
      const remaining = queue.filter(item => !delivered.has(item.messageId))
      if (remaining.length !== queue.length) { updateThreadMeta(row.executionId, { subagentGuidance: remaining }); continue }
      if (row.meta.subagentGuidancePaused || row.turnActive || row.pendingInput || row.pendingPermission || row.meta.submissionUnknown || row.recoveryReason || !["working", "complete", "cancelled", "error"].includes(row.state)) continue
      const item = queue[0], attemptKey = `${row.executionId}:${item.requestId}:${row.lastSequence}`
      if (subagentGuidanceAttempts.current.has(attemptKey)) continue
      subagentGuidanceAttempts.current.add(attemptKey)
      void sendAgentMessage(row.executionId, item.text, false, { messageId: item.messageId, source: "parentAgent" }).then(() => {
        const current = latestThreads.current.find(candidate => candidate.executionId === row.executionId)
        if (current?.transcript.some(event => event.type === "userMessage" && event.messageId === item.messageId)) updateThreadMeta(row.executionId, { subagentGuidance: (current.meta.subagentGuidance || []).filter(entry => entry.requestId !== item.requestId) })
      }).catch(error => { setError(messageOf(error)) })
    }
  }, [allThreads])
  useEffect(() => {
    if (!current?.persistent || !onReattach || !transportId || !connectedHere || !["saved", "detached"].includes(current.state)) return
    const key = `${current.executionId}:${transportId}:${current.state}`
    if (attachAttempt.current === key) return
    attachAttempt.current = key
    const revision = navigation.current
    setRestoring(true)
    void onReattach(current).then(() => { if (mounted.current && revision === navigation.current) setGitRefreshEpoch(epoch => epoch + 1) }).catch(failure => { if (mounted.current && revision === navigation.current) setError(messageOf(failure)) }).finally(() => { if (mounted.current && revision === navigation.current) setRestoring(false) })
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
      return launch ? launch(agent, { ...options, ...(current.meta.parentConversationId ? { parentConversationId: current.meta.parentConversationId } : {}), customAgent: customLaunchOptions(agent, current.meta.hostKey, prefsRef.current.customAgents, current.customAgent) }) : Promise.reject(new Error("Connect an agent before resuming this conversation."))
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
  const agentId = current?.agentId || (agents.some(agent => agent.id === prefs.agent) ? prefs.agent : AGENTS[0].id)
  const definition = agents.find(agent => agent.id === agentId) || AGENTS[0]
  const customAgent = context ? prefs.customAgents[context.host]?.find(agent => agent.id === agentId) : undefined
  const executable = customAgent?.executable || (context ? prefs.executables[context.host]?.[agentId]?.trim() || undefined : undefined)
  const available = discovery.agents.find(agent => agent.agentId === agentId)
  const draftKey = project ? projectKey(project) : "unassigned"
  const configurationKey = JSON.stringify([contextKey, agentId, executable, customAgent])
  const startScreen = !current && !archived && view !== "settings"
  const preparing = hydrated && startScreen && connectedHere && discoveryCurrent && available?.available === true && !discovery.checking
  const preparation = usePreparedAgent(`${configurationKey}:${draftGeneration}`, preparing, agentId, { cwd: context?.folder, executable, customAgent, ...(parentReturnId ? { parentConversationId: parentReturnId } : {}) }, context?.host || "", onStart)
  const prepared = allThreads.find(row => row.meta.id === preparation.id) || null
  const activeAgent = current || prepared
  const repositoryCwd = activeAgent?.cwd || current?.meta.folder || ""
  const repositoryConnected = !!current && connectedHere && !!transportId
  const repositoryEnabled = review && reviewMode === "repository"
  const git = useAgentGit({
    hostKey: current?.meta.hostKey || "", nativeSessionId: repositoryConnected ? transportId : undefined,
    cwd: repositoryCwd, conversationId: current?.meta.id || "", enabled: repositoryEnabled, refreshEpoch: gitRefreshEpoch,
  })
  const repositoryCount = git.status.snapshot?.state === "ready" ? git.status.snapshot.entries.length : undefined
  const lastGitTurn = useRef<{ executionId: string; active: boolean } | null>(null)
  useEffect(() => {
    const executionId = activeAgent?.executionId || "", active = !!activeAgent?.turnActive
    const previous = lastGitTurn.current
    if (previous?.executionId === executionId && previous.active && !active && repositoryEnabled) void git.refreshAfterCurrent()
    lastGitTurn.current = { executionId, active }
  }, [activeAgent?.executionId, activeAgent?.turnActive, repositoryEnabled, git.refreshAfterCurrent])
  const capabilityProviderLabel = activeAgent?.agentName || agents.find(agent => agent.id === activeAgent?.agentId)?.label || activeAgent?.agentId || definition.label
  const capabilityState: "connecting" | "live" | "offline" | "unavailable" = !activeAgent
    ? "unavailable"
    : activeAgent.state === "connecting" ? "connecting"
      : !connectedHere || ["saved", "detached"].includes(activeAgent.state) ? "offline"
        : ["error", "submissionUnknown"].includes(activeAgent.state) ? "unavailable" : "live"
  const capabilityRefreshAvailable = !!activeAgent && connectedHere && !["saved", "detached", "error", "submissionUnknown"].includes(activeAgent.state)
  const agentDetailsScopeKey = activeAgent ? JSON.stringify([activeAgent.executionId, activeAgent.agentId, activeAgent.agentSessionId, activeAgent.cwd, contextKey, transportId]) : "no-agent"
  const draft = current ? current.meta.draft : prefs.drafts[draftKey] || ""
  const attachments: AgentDraftAttachment[] = current ? current.meta.draftAttachments || [] : prefs.draftAttachments?.[draftKey] || []
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
  const timelineMatches = timelineOpen ? items.filter(item => ["user", "assistant"].includes(item.kind) && item.text.toLowerCase().includes(timelineQuery.toLowerCase())) : []
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
  const composerCollapsed = !!current && !composerExpanded && !draft && !attachments.length
  const { dock: composerDock, compact: compactChat } = useComposerOverlay(!!current)
  const canSend = hydrated && connectedHere && !busy && !configBusy && (!!draft.trim() || attachments.length > 0) && (current ? idle(current) && !current.meta.archivedAt : preparation.ready && idle(prepared))
  const threads = libraryThreads.filter(row => !!row.meta.archivedAt === archived && (!query || `${threadTitle(row)} ${row.meta.folder} ${hostLabel(row.meta.hostKey)} ${row.agentName}`.toLowerCase().includes(query.toLowerCase())))
  const projects = [...prefs.projects]
  for (const row of libraryThreads) if (!projects.some(p => p.host === row.meta.hostKey && p.folder === row.meta.folder)) projects.push({ host: row.meta.hostKey, folder: row.meta.folder })
  const activity = (p: AgentProject) => Math.max(0, ...libraryThreads.filter(row => row.meta.hostKey === p.host && row.meta.folder === p.folder).map(row => row.meta.activityAt))
  const sortedProjects = projects.filter(p => (!archived && !query) || threads.some(row => row.meta.hostKey === p.host && row.meta.folder === p.folder)).sort((a, b) => prefs.sort === "name" ? (a.name || folderName(a.folder)).localeCompare(b.name || folderName(b.folder)) : prefs.sort === "recent" ? activity(b) - activity(a) : 0)
  const listMotion = useAgentListMotion(JSON.stringify([sortedProjects.map(projectKey), prefs.collapsed, prefs.sort, threads.map(row => [row.meta.id, row.meta.order, row.meta.pinned, row.meta.activityAt])]))
  const knownServers = [...prefs.servers, ...sessions, ...(session ? [session] : [])]
  const hosts = [...new Map([...projects.map(p => sessionForHost(p.host, knownServers)).filter((s): s is Session => !!s), ...knownServers].map(s => [hostKey(s), s])).values()]
  const providerCommands = activeAgent?.commands || []
  const commands = commandInventory(providerCommands, agentId, otherControls)
  const sidebarExpanded = sidebar || !prefs.sidebarCollapsed
  const sidebarOverlay = sidebar && narrowNavigation
  const todosDialog = compactChat && todosOpen && !!current?.todos?.items.length
  const dialogOpen = !!customSetup || !!removingCustom || folderOpen || !!deleting || timelineOpen || !!historyAction || !!extraControl || !!expandedRequest || todosDialog
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
  const checkDiscovery = () => {
    const currentHost = host
    const paths = { ...(prefsRef.current.executables[currentHost] || {}) }
    const selectedCheck = callbacks.current.onCheck
    const custom = prefsRef.current.customAgents[currentHost] || []
    return discoverAgents(currentHost, discoverySelectionKey, () => {
      return custom.length || AGENTS.some(agent => paths[agent.id]?.trim())
        ? Promise.all(agentsForHost(currentHost, prefsRef.current.customAgents).map(agent => selectedCheck(agent.id, paths[agent.id]?.trim() || undefined, custom.find(row => row.id === agent.id)))).then(rows => rows.flat())
        : selectedCheck()
    })
  }
  useEffect(() => {
    if (!hydrated || !session) return
    const profile = agentServerProfile(session)
    setPrefs(old => ({ ...old, servers: [...old.servers.filter(server => hostKey(server) !== host), profile] }))
  }, [hydrated, host, session?.authMethod, session?.keyId])
  useEffect(() => { for (const server of hosts) claimAgentThreads(server, sessions.filter(s => hostKey(s) === hostKey(server)).map(s => s.id)) }, [hydrated, allThreads.length, sessions])
  useEffect(() => {
    if (!hydrated || !host || !connected) return
    void checkDiscovery()
  }, [host, connected, transportId, hydrated, customDiscoveryKey])
  useEffect(() => { setCatalogError(""); setConfigError(""); setConfigBusy(false); setHistoryAction(null); setModelMenu(null); setExtraControl(null); setExpandedRequest(null) }, [contextKey, agentId, selected])
  useEffect(() => { if (current) void subscribeRemoteAgent(current.executionId); setError(""); setMenu(null); setCommandOpen(false) }, [selected, current?.executionId])
  useEffect(() => { setReview(false); setTodosOpen(false) }, [selected, view])
  useEffect(() => { if (!current?.todos?.items.length) setTodosOpen(false) }, [current?.meta.id, current?.todos?.items.length])
  useLayoutEffect(() => { setAgentDetailsOpen(false) }, [contextKey, agentId, activeAgent?.executionId, activeAgent?.agentId, activeAgent?.agentSessionId, activeAgent?.cwd, transportId, view])
  useLayoutEffect(() => {
    const input = textarea.current
    if (!input) return
    if (composerCollapsed) { input.style.height = ""; return }
    const resize = () => {
      if (!input.clientWidth) return
      const style = getComputedStyle(input)
      const minHeight = Number.parseFloat(style.minHeight) || 0
      const maxHeight = Number.parseFloat(style.maxHeight) || Infinity
      input.style.height = "0px"
      input.style.height = `${Math.min(maxHeight, Math.max(minHeight, input.scrollHeight))}px`
    }
    let previousWidth = input.clientWidth, frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(resize)
    }
    const observer = new ResizeObserver(() => {
      const width = input.clientWidth
      if (width === previousWidth) return
      previousWidth = width
      schedule()
    })
    observer.observe(input)
    window.addEventListener("resize", schedule)
    document.fonts.addEventListener("loadingdone", schedule)
    resize()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); document.fonts.removeEventListener("loadingdone", schedule) }
  }, [draft, selected, view, composerCollapsed, attachments.length])
  const { form: composerForm, setExpanded: setComposerExpanded } = useComposerMotion(composerCollapsed, composerExpanded, changeComposerExpanded)
  useEffect(() => { mounted.current = true; const previous = document.activeElement as HTMLElement | null; surface.current?.focus(); return () => { mounted.current = false; void flushAgentSaves(); if (previous?.isConnected) previous.focus() } }, [])
  useLayoutEffect(() => {
    if (!dialogOpen) return
    const previous = returnFocus.current
    const modal = surface.current?.querySelector<HTMLElement>(".agent-modal")
    const controls = [...(modal?.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)') || [])].filter(node => node.getClientRects().length && !node.closest("[inert]"))
    const target = expandedRequest ? modal?.querySelector<HTMLElement>('[aria-label="Close expanded request"]') : controls.find(node => node.matches("input:not([readonly]),select")) || controls[0]
    target?.focus({ preventScroll: true })
    return () => { requestAnimationFrame(() => {
      if (surface.current?.querySelector(".agent-modal")) return
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true })
      else if (expandedRequest) (surface.current?.querySelector<HTMLElement>(`[data-timeline-id="${CSS.escape(expandedRequest)}"] .agent-request-expand`) || textarea.current)?.focus({ preventScroll: true })
      else if (removingCustom) surface.current?.querySelector<HTMLButtonElement>(".agent-custom-section > button")?.focus({ preventScroll: true })
      else textarea.current?.focus({ preventScroll: true })
    }) }
  }, [!!customSetup, !!removingCustom, folderOpen, !!deleting, timelineOpen, !!historyAction, extraControl, expandedRequest, todosDialog])
  useEffect(() => {
    if (!projectChoices) return
    const outside = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('.agent-context-choices,[data-agent-popover-trigger]')) setProjectChoices(false)
    }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [projectChoices])
  useEffect(() => {
    if (!agentDetailsOpen) return
    const outside = (event: PointerEvent) => {
      if (!agentDetailsRoot.current?.contains(event.target as Node)) setAgentDetailsOpen(false)
    }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [agentDetailsOpen])

  const setDraft = (text: string) => current ? updateThreadMeta(current.executionId, { draft: text }) : setPrefs(old => ({ ...old, drafts: { ...old.drafts, [draftKey]: text } }))
  const setAttachments = (next: AgentDraftAttachment[]) => current
    ? updateThreadMeta(current.executionId, { draftAttachments: next })
    : setPrefs(old => ({ ...old, draftAttachments: { ...old.draftAttachments, [draftKey]: next } }))
  const addAttachments = async (incoming: File[]) => {
    if (!context) { setAttachmentError("Choose a project before adding attachments."); return }
    const problem = validateAttachments(attachments, incoming)
    if (problem) { setAttachmentError(problem); return }
    setAttachmentError("")
    const added: AgentDraftAttachment[] = []
    try {
      for (const file of incoming) {
        const id = attachmentId()
        await saveAttachmentFile(id, file)
        added.push({ id, name: file.name || "attachment", type: file.type || "application/octet-stream", size: file.size, hostKey: context.host, folder: context.folder })
      }
      setAttachments([...attachments, ...added])
    } catch (failure) {
      await Promise.all(added.map(file => removeAttachmentFile(file.id).catch(() => {})))
      setAttachmentError(`Could not store this attachment locally: ${messageOf(failure)}`)
    }
  }
  const removeAttachment = (id: string) => {
    setAttachments(attachments.filter(file => file.id !== id))
    setAttachmentProgress(old => { const next = { ...old }; delete next[id]; return next })
    void removeAttachmentFile(id).catch(failure => setAttachmentError(`Could not remove the local attachment: ${messageOf(failure)}`))
  }
  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation() } catch (e) { setError(messageOf(e)) } finally { if (mounted.current) setBusy(false) } }
  const resumeSavedSession = () => {
    if (!current || !connectedHere || !transportId || !onStart || !canResumeAgentThread(current)) return
    const revision = navigation.current
    void run(async () => {
      setRestoring(true)
      try {
        const resumeExecutable = prefsRef.current.executables[current.meta.hostKey]?.[current.agentId]?.trim() || undefined
        const next = await resumeAgentThread(current.executionId, (agent, options) => callbacks.current.onStart!(agent, { ...options, ...(current.meta.parentConversationId ? { parentConversationId: current.meta.parentConversationId } : {}), customAgent: customLaunchOptions(agent, current.meta.hostKey, prefsRef.current.customAgents, current.customAgent) }), resumeExecutable)
        if (mounted.current && revision === navigation.current) {
          setSelected(next.meta.id)
          setGitRefreshEpoch(epoch => epoch + 1)
        }
      } finally { if (mounted.current) setRestoring(false) }
    })
  }
  const selectHost = (key: string) => { const server = sessionForHost(key, hosts); if (server) onSelectHost?.(server) }
  const openReview = (mode: "repository" | "conversation", trigger?: HTMLElement) => {
    reviewReturnFocus.current = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setReviewMode(mode)
    setReview(true)
  }
  const closeReview = () => {
    setReview(false)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = reviewReturnFocus.current?.isConnected && !reviewReturnFocus.current.closest("[inert]")
          ? reviewReturnFocus.current
          : surface.current?.querySelector<HTMLElement>(".agent-topbar-changes-icon")
        target?.focus({ preventScroll: true })
      })
    })
  }
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
  const home = () => { navigation.current++; setSelected(null); setParentReturnId(null); setProject(null); setView("home"); setCommandOpen(false); setMenu(null); setProjectChoices(false); setSidebar(false); setError("") }
  const openProject = (p: AgentProject) => { navigation.current++; setSelected(null); setParentReturnId(null); setProject(p); setView("project"); setCommandOpen(false); setMenu(null); setSidebar(false); setError(""); selectHost(p.host) }
  const newThread = (p: AgentProject | null = null) => { navigation.current++; setDraftGeneration(value => value + 1); setSelected(null); setParentReturnId(null); setProject(p); setView("draft"); setArchived(false); setCommandOpen(false); setMenu(null); setProjectChoices(false); setSidebar(false); setError(""); if (p) selectHost(p.host); requestAnimationFrame(() => { if (!surface.current?.querySelector(".agent-command-menu")) textarea.current?.focus() }) }
  const assignProject = (p: AgentProject) => {
    if (startScreen && !current && !project && prefsRef.current.drafts.unassigned) {
      const key = projectKey(p)
      if (!prefsRef.current.drafts[key]) setPrefs(old => ({ ...old, drafts: { ...old.drafts, [key]: old.drafts.unassigned, unassigned: "" } }))
      else setFeedback("This project has a draft. Your unassigned idea is kept in New conversation.")
    }
    newThread(p)
  }
  const selectThread = (row: AgentThreadRow) => { navigation.current++; setSelected(row.meta.id); setParentReturnId(row.meta.parentConversationId || null); setProject({ host: row.meta.hostKey, folder: row.meta.folder }); setView("draft"); setSidebar(false); selectHost(row.meta.hostKey) }
  const openParentThread = () => { if (parentThread) selectThread(parentThread) }
  const newSubagent = () => {
    if (!current || isSubagent) return
    if (childThreads.filter(subagentInFlight).length >= 3) { setError("This parent already has three active subagents. Wait for one to finish before creating another."); return }
    const parentId = current.meta.id
    newThread({ host: current.meta.hostKey, folder: current.meta.folder })
    setParentReturnId(parentId)
  }
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
    if (!context || !connectedHere || !discoveryCurrent || available?.available !== true || !prepared || !preparation.ready) throw new Error("Wait for the selected agent to finish connecting.")
    if (parentReturnId) {
      const parent = allThreads.find(row => row.meta.id === parentReturnId)
      if (!parent || parent.meta.parentConversationId || parent.meta.hostKey !== context.host || parent.meta.folder !== context.folder) throw new Error("This subagent's parent is unavailable or belongs to a different project. Return to the parent and try again.")
      if (allThreads.filter(row => row.meta.parentConversationId === parentReturnId && subagentInFlight(row)).length >= 3) throw new Error("This parent already has three active subagents. Wait for one to finish before starting another.")
    }
    preparation.claim()
    updateThreadMeta(prepared.executionId, { prepared: false, draft, ...(parentReturnId ? { parentConversationId: parentReturnId } : {}) })
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
      if (argument?.trim()) updateThreadMeta(current.executionId, { title: argument.trim(), titleSource: "user" })
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
    else if (command.name === "models") {
      if (!modelControl) { setError(context ? `${definition.label}’s model controls appear when its connection is ready.` : "Choose a project before selecting a model."); return }
      setProjectChoices(false); setModelMenu("model")
    }
    else if (command.name === "variants") {
      setProjectChoices(false); setModelMenu(null)
      requestAnimationFrame(() => { setComposerExpanded(true); requestAnimationFrame(() => surface.current?.querySelector<HTMLButtonElement>(".agent-reasoning-trigger")?.focus({ preventScroll: true })) })
    }
    else if (command.name === "agents") {
      if (!agentModeControl) { setError(context ? `${definition.label} has no selectable agent modes for this conversation.` : "Choose a project to load agent modes."); return }
      requestAnimationFrame(() => surface.current?.querySelector<HTMLButtonElement>(`[data-config-id="${CSS.escape(agentModeControl.id)}"] > button`)?.click())
    }
    else if (command.configId) { setExtraControl(command.configId); setConfigError("") }
  }
  const send = async () => {
    const text = draft.trim(), submittedAttachments = [...attachments], parsed = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    const command = commands.find(c => c.name === parsed?.[1]) || commands.find(c => c.aliases?.includes(parsed?.[1] || ""))
    if (command?.route === "client" || command?.unavailable) { chooseCommand(command, parsed?.[2]); if (!command.unavailable) setDraft(""); return }
    if (!canSend) return
    if (command && submittedAttachments.length) { setAttachmentError("Remove attachments before running a slash command. Send attachments as a regular prompt."); return }
    if (submittedAttachments.some(file => file.hostKey !== context?.host || file.folder !== context?.folder)) { setAttachmentError("These attachments belong to a different project. Remove them and add them again here."); return }
    const revision = navigation.current
    await run(async () => {
      const row = current || start()
      if (!idle(row)) return
      if (!current && submittedAttachments.length) updateThreadMeta(row.executionId, { draftAttachments: submittedAttachments })
      const sent: AgentDraftAttachment[] = []
      for (const attachment of submittedAttachments) {
        if (attachment.remotePath) { sent.push(attachment); continue }
        const file = await loadAttachmentFile(attachment.id)
        if (!file) throw new Error(`${attachment.name} is no longer available on this device. Remove it and attach it again.`)
        if (!transportId || !connectedHere) throw new Error("Reconnect to this project’s server before uploading attachments.")
        setAttachmentProgress(old => ({ ...old, [attachment.id]: "Uploading…" }))
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onerror = () => reject(reader.error || new Error("Could not read the attachment."))
            reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "")
            reader.readAsDataURL(file)
          })
          const uploaded = await nativeBridge.agentUploadAttachment(transportId, row.meta.id, attachment.id, attachment.name, base64)
          const complete = { ...attachment, remotePath: uploaded.remotePath }
          sent.push(complete)
          const saved = submittedAttachments.map(item => sent.find(done => done.id === item.id) || item)
          if (current) updateThreadMeta(row.executionId, { draftAttachments: saved })
          else setPrefs(old => ({ ...old, draftAttachments: { ...old.draftAttachments, [draftKey]: saved } }))
          setAttachmentProgress(old => ({ ...old, [attachment.id]: "Uploaded" }))
        } catch (failure) {
          setAttachmentProgress(old => ({ ...old, [attachment.id]: "Upload failed" }))
          throw failure
        }
      }
      const attachmentContext = sent.length ? `\n\nAttached files uploaded to this server (remote paths; image understanding depends on the selected agent):\n${sent.map(file => `- ${markdownCode(file.name.replace(/[\r\n]/g, " "))}: ${markdownCode(file.remotePath || "")}`).join("\n")}` : ""
      const message = `${text}${attachmentContext}`.trim() || `Please inspect the attached file${sent.length === 1 ? "" : "s"}.${attachmentContext}`
      await sendAgentMessage(row.executionId, message)
      const cleared = current ? clearAgentDraft(row.executionId, text, submittedAttachments.map(file => file.id))
        : (prefsRef.current.drafts[draftKey] || "").trim() === text.trim() && (prefsRef.current.draftAttachments?.[draftKey] || []).map(file => file.id).join("|") === submittedAttachments.map(file => file.id).join("|")
      if (!current && cleared) {
        setPrefs(old => ({ ...old, drafts: { ...old.drafts, [draftKey]: "" }, draftAttachments: { ...old.draftAttachments, [draftKey]: [] } }))
        if (submittedAttachments.length) updateThreadMeta(row.executionId, { draftAttachments: [] })
      }
      if (cleared) await Promise.all(submittedAttachments.map(file => removeAttachmentFile(file.id).catch(() => {})))
      setAttachmentProgress({}); setAttachmentError("")
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
    else updateThreadMeta(rename.id, { title: rename.title.trim(), titleSource: "user" })
    setRename(null)
  }
  const useStarter = (prompt: string) => {
    if (draft.trim()) return
    setDraft(prompt)
    setView("draft")
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(prompt.length, prompt.length) })
  }
  const check = checkDiscovery
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
  const renderSidebarPanel = (panelId: string, attachRefs: boolean) => <div className="agent-sidebar-panel agent-sidebar-panel--readable" id={panelId} inert={!sidebarExpanded} aria-hidden={!sidebarExpanded}>
    <button className="agent-sidebar-new" aria-label="New conversation" disabled={!hydrated} onClick={() => newThread()}><AgentIcon name="compose" size={17} /><span>New conversation</span></button>
    <label className="agent-sidebar-search"><AgentIcon name="search" size={15} /><input ref={attachRefs ? search : undefined} aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <button className={`agent-sidebar-archive ${archived ? "is-selected" : ""}`} onClick={() => { setArchived(!archived); home() }}><AgentIcon name="archive" size={16} /><span>{archived ? "All conversations" : "Archived"}</span>{allThreads.some(row => row.meta.archivedAt) && <small>{allThreads.filter(row => row.meta.archivedAt).length}</small>}</button>
    <div className="agent-project-heading">
      <span>{archived ? "Archived" : "Projects"}</span>
      <button className="agent-sidebar-view agent-thread-more" aria-label="View options" title="View options" aria-haspopup="dialog" aria-expanded={menu === "sidebar:view"} onClick={() => setMenu(menu === "sidebar:view" ? null : "sidebar:view")}><AgentIcon name="settings" size={14} /></button>
      <button className="agent-icon-button" aria-label="Add project folder" title="Add project" onClick={chooseFolder}><AgentIcon name="plus" size={15} /></button>
    </div>
    <nav ref={attachRefs ? listMotion : undefined} className="agent-thread-list ag-list-guide" aria-label="Conversations by folder">
      {sortedProjects.map(p => {
        const key = projectKey(p), collapsed = prefs.collapsed.includes(key) && !query
        const rows = threads.filter(row => row.meta.hostKey === p.host && row.meta.folder === p.folder).sort((a, b) => Number(b.meta.pinned) - Number(a.meta.pinned) || (prefs.sort === "name" ? threadTitle(a).localeCompare(threadTitle(b)) : prefs.sort === "manual" ? b.meta.order - a.meta.order : b.meta.activityAt - a.meta.activityAt))
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
    <footer className="agent-sidebar-footer agent-sidebar-footer--compact agent-sidebar-footer--settings-only">
      <button className="agent-sidebar-settings" aria-label="Agent settings" title="Agent settings" onClick={() => { setView("settings"); setSelected(null); setSidebar(false); setMenu(null) }}><AgentIcon name="settings" size={16} /><span>Settings</span></button>
      {storage.error && <div className="agent-storage-status has-error" title={`${savedStatus} · ${storage.path}`} role="status"><span className="agent-status-dot attention" /><span>{savedStatus}</span></div>}
    </footer>
  </div>
  const providerOption = { id: "provider", name: "Coding agent", category: "provider", type: "select", currentValue: agentId, options: agents.map(agent => {
    const found = discovery.agents.find(info => info.agentId === agent.id)
    return { value: agent.id, name: agent.label, description: found?.available ? "Installed on this server" : found?.installed ? found.message || "Integration unavailable" : found ? "Not installed on this server" : discovery.checking ? "Checking installation…" : "Not checked" }
  }) }
  const projectName = context ? projects.find(p => projectKey(p) === contextKey)?.name || folderName(context.folder) : ""
  const recent = threads.filter(row => view !== "project" || context && row.meta.hostKey === context.host && row.meta.folder === context.folder).sort((a, b) => Number(b.meta.pinned) - Number(a.meta.pinned) || b.meta.activityAt - a.meta.activityAt)
  const composerNotice = discovery.checking ? "Finding agents…" : catalogBusy ? "Loading commands…" : !current && connectedHere && available && !available.available ? `${definition.label} is unavailable` : null
  const nativeShell = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

  const topbarIdle = !!current && !current.turnActive && !current.pendingPermission && !current.pendingInput && ["saved", "complete", "working"].includes(current.state)
  const topbarStatus = current && <span className={`agent-status ${current.pendingPermission || current.pendingInput ? "is-attention" : ["error", "submissionUnknown"].includes(current.state) && !current.turnActive ? "is-error" : current.turnActive ? "is-working" : ""}`} role="status" title={statusOf(current)}><span className={`agent-status-dot ${current.pendingPermission || current.pendingInput ? "attention" : ["error", "submissionUnknown"].includes(current.state) && !current.turnActive ? "error" : current.turnActive ? "working" : ""}`} /><span className={topbarIdle ? "agent-sr-only" : "agent-topbar-status-label"}>{statusOf(current)}</span></span>

  return <section ref={surface} className={`agent-workspace${mobile ? " agent-workspace--mobile" : ""}${closing ? " is-closing" : ""}${review && current ? " is-reviewing" : ""}`} data-native-shell={nativeShell ? "true" : undefined} tabIndex={-1} role="dialog" aria-modal="true" aria-label={session ? `Agents on ${session.name}` : "Agents workspace"}
    onFocusCapture={e => { if (!(e.target as HTMLElement).closest('.agent-modal,.agent-thread-menu,.agent-picker-popup,.agent-model-menu,.agent-command-menu,.agent-context-choices,.agent-capabilities-popover')) returnFocus.current = e.target as HTMLElement }}
    onPointerDown={e => { if (!(e.target as HTMLElement).closest(".agent-thread-menu,.agent-thread-more")) setMenu(null) }}
    onKeyDown={e => {
      e.stopPropagation()
      if (!dialogOpen && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); setSidebar(false); setProjectChoices(false); setModelMenu(null); setAgentDetailsOpen(false); if (!showComposer) newThread(); setCommandQuery(""); setCommandOpen(true) }
      if (!folderOpen && !timelineOpen && !deleting && !historyAction && (e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault()
        if (review) closeReview()
        if (matchMedia("(max-width: 800px)").matches && !sidebar) revealProjects()
        else toggleProjects()
      }
      if (e.key === "Escape") { e.preventDefault(); if (expandedRequest) setExpandedRequest(null); else if (todosDialog) setTodosOpen(false); else if (agentDetailsOpen) setAgentDetailsOpen(false); else if (extraControl) setExtraControl(null); else if (modelMenu) setModelMenu(null); else if (historyAction) { if (!busy) setHistoryAction(null) } else if (deleting) setDeleting(null); else if (timelineOpen) setTimelineOpen(false); else if (customSetup) setCustomSetup(null); else if (removingCustom) setRemovingCustom(null); else if (folderOpen) closeFolder(); else if (rename) setRename(null); else if (projectChoices) setProjectChoices(false); else if (commandOpen) setCommandOpen(false); else if (menu) setMenu(null); else if (review) closeReview(); else if (sidebar) setSidebar(false); else if (view === "settings") home(); else onClose() }
      if (e.key === "Tab") {
        const root = surface.current?.querySelector(".agent-modal") || (sidebarOverlay ? surface.current?.querySelector(".agent-thread-menu") || navigationPanel.current : null) || surface.current?.querySelector('.agent-review[aria-modal="true"]') || (projectChoices ? projectPopover.current : null) || surface.current
        const elements = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]') || [])].filter(el => el.getClientRects().length && !el.closest("[inert]"))
        if (e.shiftKey && (document.activeElement === elements[0] || document.activeElement === surface.current)) { e.preventDefault(); elements.at(-1)?.focus() }
        else if (!e.shiftKey && document.activeElement === elements.at(-1)) { e.preventDefault(); elements[0]?.focus() }
      }
    }}>
    {!mobile && <AgentAurora />}
    {sidebarOverlay && <button className="agent-sidebar-scrim" tabIndex={-1} aria-label="Hide projects" onClick={toggleProjects} />}
    {!mobile && <aside ref={navigationPanel} inert={dialogOpen} className={`agent-sidebar ${sidebarExpanded ? "" : "is-collapsed"} ${sidebar ? "is-open" : ""}`} role={sidebarOverlay ? "dialog" : "complementary"} aria-modal={sidebarOverlay || undefined} aria-label="Projects and conversations">
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
      {renderSidebarPanel("agent-project-navigation", true)}
      {menu === "sidebar:view" && <AgentMenu root={surface.current} role="dialog" label="View options" className="agent-view-menu"><label>Sort conversations<select aria-label="Sort projects and conversations" value={prefs.sort} onChange={event => { setPrefs(old => ({ ...old, sort: event.target.value as typeof old.sort })); setMenu(null) }}><option value="recent">Recent</option><option value="name">A–Z</option><option value="manual">Manual</option></select></label></AgentMenu>}
      {menu === "sidebar:more" && <AgentMenu root={surface.current}><button role="menuitem" onClick={() => { setArchived(!archived); home() }}><AgentIcon name="archive" />{archived ? "All conversations" : "Archived"}</button><button role="menuitem" onClick={() => { setView("settings"); setSelected(null); setSidebar(false); setMenu(null) }}><AgentIcon name="settings" />Agent settings</button><button role="menuitem" onClick={onClose}><AgentIcon name="panel" />Back to workspace</button></AgentMenu>}
    </aside>}
    <main className={`agent-main ${review && current ? "has-review" : ""}`} inert={sidebarOverlay || dialogOpen}>
      <div className="agent-sr-only" role="status" aria-atomic="true">{current?.pendingPermission ? `Approval needed: ${current.pendingPermission.title}` : current?.pendingInput ? `Agent question: ${current.pendingInput.title}` : ""}</div>

      {mobile ? <header className="mobile-detail-bar mobile-agent-header"><button className="mobile-icon-button" aria-label={review ? "Back to conversation" : "Back to threads"} onClick={review ? closeReview : onClose}><AgentIcon name="back" size={22} /></button><div><h1>{review ? "Changes" : current ? threadTitle(current) : view === "settings" ? "Agent settings" : "New task"}</h1>{current ? <p>{topbarStatus}</p> : <p>{context ? projectName : view === "settings" ? "Your remote providers" : "Choose a remote project"}</p>}</div>{current && !review && <button className="mobile-icon-button" aria-label="Review changes" onClick={event => openReview("conversation", event.currentTarget)}><AgentIcon name="changes" size={21} /></button>}{current && !review && <button className="mobile-icon-button" aria-label="Find a message" onClick={() => { setTimelineQuery(""); setTimelineOpen(true) }}><AgentIcon name="search" size={21} /></button>}</header> : <header className={`agent-topbar agent-topbar--stacked agent-topbar--compact${review && current ? " is-reviewing" : ""}`} data-tauri-drag-region>
        <div className="agent-topbar-leading agent-topbar-leading--focused">
          {review && current ? <>
            <button type="button" className="agent-review-back" aria-label="Back to chat" onClick={closeReview}><AgentIcon name="back" size={15} /><span>Chat</span></button>
            <span className="agent-review-topbar-divider" aria-hidden="true" />
            <strong className="agent-topbar-title" title={threadTitle(current)}>{threadTitle(current)}</strong>
          </> : <>
            {parentThread && <button type="button" className="agent-subagent-parent" onClick={openParentThread} title={`Back to ${threadTitle(parentThread)}`}><AgentIcon name="back" size={14} /><span>Parent chat</span></button>}
            {current ? <AgentProviderMark id={current.agentId} size={18} /> : <AgentIcon name="chat" size={17} />}
            {current && <strong className="agent-topbar-title" title={threadTitle(current)}>{threadTitle(current)}</strong>}
            {view === "settings" && <strong className="agent-topbar-title is-settings">Settings</strong>}
          </>}
        </div>
        <div className="agent-topbar-actions">
          {current && <>
            {topbarStatus}
            {!review && <>
              {!isSubagent && <button type="button" className="agent-subagents-topbar" onClick={newSubagent}><AgentIcon name="plus" size={14} /><span>New subagent</span></button>}
              <button className="agent-icon-button" aria-label="Find a message" title="Find a message" onClick={() => { setTimelineQuery(""); setTimelineOpen(true) }}><AgentIcon name="search" /></button>
              <button className="agent-icon-button agent-topbar-changes-icon" aria-label="Review changes" title="Review changes" aria-expanded={false} onClick={event => openReview("repository", event.currentTarget)}><AgentIcon name="changes" size={16} /></button>
            </>}
          </>}
          {!review && onOpenTerminal && (!context || context.host === host) && <button className="agent-icon-button" aria-label="Open terminal" title="Open terminal" onClick={onOpenTerminal}><AgentIcon name="terminal" /></button>}
          <button className="agent-icon-button" aria-label="Close agent workspace" title="Close agent workspace" onClick={onClose}><AgentIcon name="close" /></button>
        </div>
      </header>}

      {(storage.error || storage.warnings.length > 0) && <div className="agent-storage-notice" role="alert"><span>{storage.error || storage.warnings[0]}</span>{storage.error && <button className="agent-button" onClick={() => { if (!hydrated) void hydrate(); else void flushAgentSaves() }}>{hydrated ? "Retry saving" : "Retry opening history"}</button>}</div>}
      <div className="agent-workbody">
      <div className={`agent-chat ${startScreen ? "is-launch" : ""} ${startScreen && recent.length ? "has-recents" : ""}`} inert={review || undefined} aria-hidden={review || undefined}>
      {view === "settings" ? <section className="agent-setup">
        <div className="agent-settings-heading"><h1>Agent settings</h1><p>Use the coding agents already installed on your server.</p></div>
        <label className="agent-field">Server<select aria-label="Settings server" value={host} onChange={e => selectHost(e.target.value)}><option value="">Choose a server</option>{hosts.map(s => <option key={hostKey(s)} value={hostKey(s)}>{s.name} · {s.username}@{s.host}</option>)}</select></label>
        {session && connectionNotice}
        <div className="agent-settings-list">{AGENTS.map(provider => {
          const info = discovery.agents.find(row => row.agentId === provider.id)
          const checkedAt = info?.checkedAt ?? discovery.checkedAt
          const checkedLabel = Number.isSafeInteger(checkedAt) ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(checkedAt) : "Not checked"
          return <details className="agent-provider-setting" key={provider.id}><summary><span className="agent-provider-logo"><AgentProviderMark id={provider.id} size={23} /></span><span><strong>{provider.label}</strong><small>{discoveryStatus(info)}</small></span><AgentIcon name="chevron" size={14} /></summary><div className="agent-provider-details"><p>{provider.note}</p><dl className="agent-provider-runtime"><div><dt>Version</dt><dd>{info?.providerRuntime?.version || "Version not reported"}</dd></div><div><dt>Transport</dt><dd>{agentProviderTransportLabel(info?.providerRuntime?.transport)}</dd></div><div><dt>Last checked</dt><dd>{discovery.stale ? "Cached · " : ""}{checkedLabel}</dd></div></dl><label className="agent-field">Executable path<input aria-label={`${provider.label} executable path`} disabled={!host} value={prefs.executables[host]?.[provider.id] || ""} placeholder={info?.executable || provider.executable} onChange={e => setPrefs(old => ({ ...old, executables: { ...old.executables, [host]: { ...old.executables[host], [provider.id]: e.target.value } } }))} /></label>{!info?.installed && <><span>Install on the server</span><code className="agent-install-command">{provider.installCommand}</code></>}<span>Sign in on the server</span><code className="agent-install-command">{provider.loginCommand}</code></div></details>
        })}</div>
        <div className="agent-custom-section"><h2>Custom agents</h2><p>ACP-compatible CLIs configured only for this server.</p>
          {(prefs.customAgents[host] || []).map(agent => {
            const info = discovery.agents.find(row => row.agentId === agent.id)
            return <div className="agent-custom-row" key={agent.id}><AgentProviderMark id={agent.id} size={23} /><div><strong>{agent.name}</strong><small>{info ? discoveryStatus(info) : "Not checked"}</small><code>{agent.executable}</code></div><div className="agent-inline-actions"><button className="agent-button" onClick={() => setCustomSetup(agent)}>Edit</button><button className="agent-button" onClick={() => setRemovingCustom(agent)}>Remove</button></div></div>
          })}
          <button className="agent-button" disabled={!host} onClick={() => setCustomSetup({ id: `custom-${crypto.randomUUID()}`, hostKey: host, name: "", executable: "", args: [], transport: "acp-v1" })}>Add custom agent</button>
        </div>
        <div className="agent-inline-actions"><button className="agent-button" disabled={!host || !connected || discovery.checking} onClick={() => void check()}><AgentIcon name="refresh" />{discovery.checking ? "Checking…" : "Refresh"}</button><button className="agent-button" onClick={home}>Back to conversations</button></div>
        {discovery.error && <p className="agent-error" role="alert">{discovery.error}</p>}
        <div className="agent-local-settings"><h2>History on this device</h2><p>Conversations and drafts stay available when your server is offline.</p><code>{storage.path || "Opening local storage…"}</code></div>
      </section> : <>
        {current && !isSubagent && <AgentSubagents children={childThreads} onOpen={selectThread} onCreate={newSubagent} />}
        {isSubagent && <div className="agent-subagent-context"><AgentIcon name="folder" size={13} /><span>Subagent of <strong>{parentThread ? threadTitle(parentThread) : "unavailable parent"}</strong></span><span>·</span><span>Shared project folder</span></div>}
        <div ref={scroll.viewport} className={`agent-conversation${current ? " agent-conversation--hierarchy" : ""}`} tabIndex={0} aria-label="Conversation" onScroll={scroll.onScroll} onWheel={scroll.onWheel}>
          <div ref={scroll.content} className="agent-message-list">
            {current ? <>{firstItem > 0 && <div className="agent-history-page"><button onClick={loadEarlier}>Load earlier activity <span>{firstItem} more</span></button><button className="agent-link-button" onClick={() => { setTimelineQuery(""); setTimelineOpen(true) }}>Find a message</button></div>}<AgentTimeline items={visibleItems} agentName={current.agentName} agentId={current.agentId} plan={plan} actions={historyActions} requests={requestActions} turnActive={turnActive} />{!items.length && <div className="agent-thread-empty"><AgentProviderMark id={current.agentId} size={34} /><h2>{current.state === "connecting" ? `Connecting ${current.agentName}…` : idle(current) ? `${current.agentName} is ready` : current.state === "saved" ? "Saved conversation" : "Agent connection unavailable"}</h2><p>{current.state === "connecting" ? "Loading the models and commands from your server." : idle(current) ? "Send a message to get started." : "Your conversation remains available on this device."}</p></div>}{turnActive && !hasActiveReasoning && <div className="agent-working" role="status"><AgentProviderMark id={current.agentId} size={16} /><span className="agent-status-dot working" />{current.lastError?.includes("Cancellation") ? "Stopping…" : "Working…"}</div>}{changes.length > 0 && <AgentChangeSummary changes={changes} open={trigger => openReview("conversation", trigger)} />}</>
              : startScreen ? <div className="agent-welcome"><h1>{mobile ? "What’s on your mind?" : <>What will you <em>build?</em></>}</h1>{context && <button className="agent-welcome-project" title={`${hostLabel(context.host)} · ${context.folder}`} onClick={() => setProjectChoices(!projectChoices)}><AgentIcon name="folder" size={16} />{projectName}<AgentIcon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} /></button>}</div>
                : <div className="agent-home"><div className="agent-home-heading"><h1>Archived conversations</h1><p>Your previous work, saved on this device.</p></div>{recent.length ? <div className="agent-recents">{recent.map(row => <button key={row.meta.id} className="agent-recent" onClick={() => selectThread(row)}><AgentProviderMark id={row.agentId} size={18} /><span><strong>{threadTitle(row)}</strong><small>{folderName(row.meta.folder)} · {row.agentName}</small></span><time>{relativeActivity(row.meta.activityAt)}</time><AgentIcon name="chevron" size={13} /></button>)}</div> : <p className="agent-muted">Nothing archived yet.</p>}</div>}
          </div>
        </div>
        {showComposer && <div ref={composerDock} className={`agent-composer-area${startScreen ? " is-compact" : ""}${composerCollapsed ? " is-collapsed" : ""}`}>
          {!scroll.atLatest && current && !activeRequestItem && <button className="agent-jump" onClick={scroll.follow}>Latest activity <AgentIcon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} /></button>}
          <div className="agent-composer-notices" role="region" tabIndex={0} aria-label="Agent notices and tasks">
          {activeRequestItem && current && <button className={`agent-request-jump ${activeRequestKind === "permission" ? "is-approval" : "is-question"}`} onClick={() => {
            if (matchMedia("(max-height: 560px)").matches) setExpandedRequest(activeRequestItem.id)
            else { findMessage(activeRequestItem.id); requestAnimationFrame(() => surface.current?.querySelector<HTMLElement>(`[data-timeline-id="${CSS.escape(activeRequestItem.id)}"] .agent-request-expand`)?.focus({ preventScroll: true })) }
          }}><span className="agent-status-dot attention" />{activeRequestKind === "permission" ? "Approval needed" : "Your answer is needed"}<span>Review request</span><AgentIcon name="chevron" size={13} /></button>}
           {current?.persistent && ["saved", "detached", "connecting"].includes(current.state) ? <div className="agent-saved-notice" role="status"><span><AgentIcon name="refresh" size={15} />{restoring || !connectedHere ? "Connecting to the server to restore this agent…" : "Agent execution is kept on your server"}</span></div> : current?.state === "saved" ? <div className="agent-saved-notice" role="status"><span><AgentIcon name={restoring ? "refresh" : "check"} size={15} />{restoring ? "Restoring this conversation from the server…" : canResumeAgentThread(current) ? connectedHere ? "Resuming the saved provider session…" : "Connecting to the saved server…" : "Saved on this device"}</span></div> : null}
          {session && connectionNotice}
            {(error || current?.lastError && ["error", "submissionUnknown"].includes(current.state)) && <div className="agent-error" role="alert">
              <span>{error || current?.lastError}</span>
              {current?.turnActive && <p>The remote agent may still be working. Stop it to request cancellation; don’t send a duplicate prompt.</p>}
              {current?.recoveryReason === "workerUnavailable" ? <>
                <p>{current.state === "submissionUnknown" || current.meta.submissionUnknown || current.recoveryRequired
                  ? "The last operation was not confirmed. Inspect the provider’s saved session before continuing; nothing will be resent."
                  : current.resumable && current.agentSessionId
                    ? "Your conversation and draft are kept. Resume the saved provider session without resending the last message."
                    : "Your saved conversation is read-only. This provider did not confirm a resumable session; start a new conversation to continue."}</p>
                {current.customAgent && !prefs.customAgents[current.meta.hostKey]?.some(agent => agent.id === current.agentId) && <button className="agent-button" onClick={() => setCustomSetup(current.customAgent!)}>Configure agent again</button>}
                {current.resumable && current.agentSessionId && <button className="agent-button" type="button" disabled={busy || restoring || configBusy || !connectedHere || !onStart || !canResumeAgentThread(current)} onClick={resumeSavedSession}>{restoring ? "Resuming…" : "Resume saved session"}</button>}
              </> : current && ["error", "submissionUnknown"].includes(current.state) && current.persistent && connectedHere && <button className="agent-button" type="button" disabled={busy} onClick={() => void run(() => reconcileAgentThread(current.executionId))}>Check remote status</button>}
            </div>}
          {!current && preparing && <div className={`agent-preparation ${preparation.error || prepared?.state === "error" ? "has-error" : ""}`} role="status"><span className={`agent-status-dot ${preparation.error || prepared?.state === "error" ? "attention" : preparation.ready ? "connected" : "working"}`} /><span>{preparation.error || (prepared?.state === "error" ? prepared.lastError : preparation.ready ? `${definition.label} connected · choose your model` : `Connecting ${definition.label} and loading models…`)}</span>{(preparation.error || prepared?.state === "error") && <button type="button" onClick={() => preparation.retry()}>Retry connection</button>}</div>}
           {current && (current.todos?.items.length || 0) > 0 && <div className={`agent-todos-dock${todosOpen && !todosDialog ? " is-expanded" : ""}`}><AgentTodos todos={current.todos} sync={current.todoSync} expanded={todosOpen && !todosDialog} expand={() => setTodosOpen(true)} collapse={() => setTodosOpen(false)} /></div>}
          </div>
          {projectChoices && <div ref={projectPopover} className="agent-context-choices" role="dialog" aria-label="Choose a project"><div><strong>Choose a project</strong><button type="button" className="agent-icon-button" aria-label="Close project choices" onClick={() => setProjectChoices(false)}><AgentIcon name="close" size={14} /></button></div>{projects.map(p => <button type="button" key={projectKey(p)} className="agent-project-choice" onClick={() => assignProject(p)}><AgentIcon name="folder" size={14} /><span>{p.name || folderName(p.folder)}<small>{hostLabel(p.host)} · {p.folder}</small></span></button>)}<button type="button" className="agent-link-button" onClick={() => { setProjectChoices(false); chooseFolder() }}>Add another project</button></div>}
          <form ref={composerForm} className={`agent-composer${current ? " has-provider" : ""}${composerCollapsed ? " is-collapsed" : ""}${draggingFiles ? " is-file-dragging" : ""}`} onDragEnter={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDraggingFiles(true) } }} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault() }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDraggingFiles(false) }} onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDraggingFiles(false); void addAttachments(Array.from(e.dataTransfer.files)) }} onFocusCapture={e => {
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
            <button type="button" className="agent-icon-button agent-attach-trigger" aria-label="Attach files" title={context ? "Attach files · paste or drop also works" : "Choose a project before attaching files"} disabled={!context || busy} onClick={() => filePicker.current?.click()}><AgentIcon name="attach" /></button>
            <input ref={filePicker} type="file" multiple hidden aria-label="Choose message attachments" onChange={e => { const files = Array.from(e.currentTarget.files || []); e.currentTarget.value = ""; void addAttachments(files) }} />
            <AgentAttachments attachments={attachments} progress={attachmentProgress} onRemove={removeAttachment} />
            {attachments.length > 0 && <p className="agent-attachment-note">Files upload to this server and are shared by path. Image understanding depends on the selected agent.</p>}
            {draggingFiles && <div className="agent-drop-hint" aria-hidden="true"><AgentIcon name="attach" size={17} />Drop files to attach</div>}
            <textarea ref={textarea} aria-label="Message agent" aria-description={mobile ? "Enter for a new line. Use Send to submit. Type / for commands." : "Enter to send. Shift+Enter for a new line. Type / for commands."} enterKeyHint={mobile ? "enter" : undefined} rows={2} placeholder={current ? "Ask for a change or a follow-up…" : "Describe a task, ask a question, or just start building…"} value={draft} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addAttachments(files); return } void readClipboardImageFile().then(file => { if (file) void addAttachments([file]) }) }} onChange={e => { setDraft(e.target.value); if (e.target.value === "/" || e.target.value === "@") { setCommandQuery(e.target.value === "@" ? "skill:" : ""); setCommandOpen(true) } }} onKeyDown={e => { if (!mobile && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
            <div className="agent-composer-toolbar">
              <div className="agent-composer-controls">
                {!current && <ConfigPicker option={providerOption} icon={<AgentProviderMark id={agentId} size={20} />} disabled={busy || configBusy} change={(_, value) => setPrefs(old => ({ ...old, agent: String(value) }))} />}
                  <AgentModelPicker key={activeAgent?.executionId || configurationKey} provider={current ? { id: current.agentId, name: current.agentName } : undefined} model={modelControl} open={modelMenu !== null} onOpenChange={open => { setModelMenu(open ? "model" : null); if (open) { setCommandOpen(false); setProjectChoices(false); setAgentDetailsOpen(false) } }} disabled={!connectedHere || !idle(activeAgent) || busy || configBusy || !current && !preparation.ready} disabledReason={current?.state === "saved" ? "Restore this conversation before changing its model" : current?.turnActive ? "Wait for the agent to finish before changing its model" : current?.state === "error" && idle(current) ? "This turn stopped; you can change its settings or continue" : "Connect the agent to configure its model"} change={changeConfig} />
                  {reasoningControl && <AgentReasoningBars key={`${activeAgent?.executionId}:${reasoningControl.id}`} option={reasoningControl} disabled={!connectedHere || !idle(activeAgent) || busy || configBusy || !current && !preparation.ready} disabledReason={current?.state === "saved" ? "Restore this conversation before changing its reasoning" : current?.turnActive ? "Wait for the agent to finish before changing its reasoning" : "Connect the agent to configure its reasoning"} change={changeConfig} />}
                {agentModeControl && <ConfigPicker className="agent-mode-picker" key={`${activeAgent?.executionId}:${agentModeControl.id}`} option={agentModeControl} label="Agent" searchable={false} disabled={!connectedHere || !idle(activeAgent) || busy || configBusy || !current && !preparation.ready} change={changeSecondaryConfig} icon={<AgentIcon name="code" size={15} />} />}
              </div>
              <div className="agent-composer-actions"><button type="button" className="agent-icon-button" aria-label="Commands and skills" title="Commands and skills · Ctrl/⌘+P" aria-haspopup="listbox" aria-expanded={commandOpen} onClick={() => { setProjectChoices(false); setCommandQuery(""); setCommandOpen(!commandOpen) }}><AgentIcon name="command" /></button>{current?.turnActive ? <button className="agent-send agent-stop" type="button" aria-label="Stop agent" title="Stop agent" disabled={busy} onClick={() => void run(() => cancelAgentTurn(current.executionId))}><AgentIcon name="stop" size={14} /></button> : <button className="agent-send" type="submit" aria-label="Send message" title={canSend ? "Send message" : !context ? "Choose a project to send" : "Send message"} disabled={!canSend}><AgentIcon name="arrow" size={19} /></button>}</div>
            </div>
          </form>
          {attachmentError && <p className="agent-attachment-error" role="alert">{attachmentError}</p>}
          {configError && !extraControl && <p className="agent-model-error" role="alert">{configError}</p>}
          <div className="agent-composer-footnote">
            {context ? <div className="agent-context-line"><AgentIcon name="folder" size={13} /><span title={context.folder}>{context.folder}</span><small title={hostLabel(context.host)}>{hostLabel(context.host)}</small>{!current && <button type="button" data-agent-popover-trigger aria-label="Change project" title="Change project" aria-haspopup="dialog" aria-expanded={projectChoices} onClick={() => { setAgentDetailsOpen(false); setCommandOpen(false); setProjectChoices(!projectChoices) }}><AgentIcon name="chevron" size={11} /></button>}{activeAgent && <div className="agent-capabilities-anchor" ref={agentDetailsRoot}>
              <button type="button" className="agent-details-trigger" aria-label="Agent details: Supported by this agent" aria-haspopup="dialog" aria-controls="agent-capabilities-popover" aria-expanded={agentDetailsOpen} onClick={() => { setCommandOpen(false); setProjectChoices(false); setModelMenu(null); setAgentDetailsOpen(open => !open) }}>Agent details</button>
              <AgentCapabilities key={agentDetailsScopeKey} open={agentDetailsOpen} report={activeAgent.capabilities} providerLabel={capabilityProviderLabel} state={capabilityState} refresh={capabilityRefreshAvailable ? () => refreshAgentThread(activeAgent.executionId) : undefined} close={() => setAgentDetailsOpen(false)} />
            </div>}</div> : <button type="button" className="agent-choose-project" data-agent-popover-trigger aria-haspopup="dialog" aria-expanded={projectChoices || folderOpen} onClick={() => { setAgentDetailsOpen(false); setCommandOpen(false); if (projects.length) setProjectChoices(!projectChoices); else chooseFolder() }}><AgentIcon name="folder" size={14} /><span>Choose project</span><AgentIcon name="chevron" size={11} style={{ transform: "rotate(90deg)" }} /></button>}
            {composerNotice && <span className="agent-composer-status" role="status">{composerNotice}</span>}
          </div>
        </div>}
        {startScreen && <div className="agent-launch-extras"><div className="agent-starters">{promptStarters.map(starter => <button key={starter.label} disabled={!!draft.trim() || busy} onClick={() => useStarter(starter.prompt)}><span>{starter.label}</span></button>)}</div>{recent.length > 0 && <section className="agent-recents"><div className="agent-section-label"><span>Recent conversations</span><button className="agent-link-button" onClick={() => revealProjects(true)}>View all {recent.length} conversations <AgentIcon name="chevron" size={12} /></button></div>{recent.slice(0, 3).map(row => <button key={row.meta.id} className="agent-recent" onClick={() => selectThread(row)}><span><strong>{threadTitle(row)}</strong><small>{folderName(row.meta.folder)} · {row.agentName}</small></span><time>{relativeActivity(row.meta.activityAt)}</time><AgentIcon name="chevron" size={13} /></button>)}</section>}</div>}
      </>}
      </div>
      {review && current && <AgentChanges key={current.meta.id} changes={changes} mode={reviewMode} onModeChange={setReviewMode} repositoryCount={repositoryCount} repository={<AgentRepositoryChanges host={hostLabel(current.meta.hostKey)} cwd={repositoryCwd} active={repositoryEnabled} connected={repositoryConnected} status={git.status} diff={git.diff} refresh={git.refresh} loadDiff={git.loadDiff} />} />}
      </div>
      {(undo || feedback) && <div className="agent-toast" role="status">{undo ? `Conversation ${undo.at ? "restored" : "archived"}` : feedback}{undo && <button onClick={() => { updateThreadMeta(undo.id, { archivedAt: undo.at }); setUndo(null) }}>Undo</button>}<button className="agent-icon-button" aria-label="Dismiss notification" onClick={() => { setUndo(null); setFeedback("") }}><AgentIcon name="close" size={13} /></button></div>}
    </main>
    {todosDialog && current && <div className="agent-confirm-backdrop"><section className="agent-modal agent-todos-modal" role="dialog" aria-modal="true" aria-label="Conversation Todos"><AgentTodos id="agent-todos-dialog-full" todos={current.todos} sync={current.todoSync} expanded expand={() => setTodosOpen(true)} collapse={() => setTodosOpen(false)} /></section></div>}
    {expandedItem && <div className="agent-confirm-backdrop agent-request-backdrop"><AgentRequest key={expandedItem.id} item={expandedItem} actions={requestActions} expanded /></div>}
    {extraControl && <div className="agent-confirm-backdrop"><section className="agent-modal agent-config-dialog" role="dialog" aria-modal="true" aria-label={fields.find(option => option.id === extraControl)?.name || "Agent control"}><div className="agent-modal-heading"><h2>{fields.find(option => option.id === extraControl)?.name || "Agent control"}</h2><button className="agent-icon-button" aria-label="Close agent control" onClick={() => setExtraControl(null)}><AgentIcon name="close" /></button></div>{fields.filter(option => option.id === extraControl).map(option => <div key={option.id}>{option.description && <p>{option.description}</p>}<ConfigPicker option={option} disabled={!connectedHere || !idle(activeAgent) || configBusy} change={changeSecondaryConfig} /></div>)}{configError && <p className="agent-model-error" role="alert">{configError}</p>}</section></div>}
    {historyAction && current && <div className="agent-confirm-backdrop"><section className="agent-modal agent-history-confirm" role="dialog" aria-modal="true" aria-labelledby="agent-history-title"><h2 id="agent-history-title">{historyAction.retry ? "Retry this message?" : "Revert to this message?"}</h2><p>{historyAction.retry ? "Return to before this message and send it again with the currently selected model." : "Return to before this message. Its replies and later messages will leave the active conversation."}</p><blockquote>{historyAction.message.text.slice(0, 240)}{historyAction.message.text.length > 240 ? "…" : ""}</blockquote><p>Project files stay as they are. {current.agentId === "pi" ? "Pi continues from a fork at this point." : "This updates the agent’s conversation history."}</p>{error && <p className="agent-error" role="alert">{error}</p>}<div className="agent-inline-actions"><button className="agent-button" disabled={busy} onClick={() => setHistoryAction(null)}>Cancel</button><button className="agent-primary" disabled={busy || !connectedHere || !canChangeAgentHistory(current, historyAction.message.messageId || "", historyAction.retry)} onClick={() => void applyHistoryAction()}>{busy ? "Updating history…" : historyAction.retry ? "Retry message" : "Revert conversation"}</button></div></section></div>}
    {timelineOpen && <div className="agent-confirm-backdrop"><section className="agent-modal" role="dialog" aria-modal="true" aria-label="Find a message"><div className="agent-modal-heading"><h2>Find a message</h2><button className="agent-icon-button" aria-label="Close message search" onClick={() => setTimelineOpen(false)}><AgentIcon name="close" /></button></div><label className="agent-field">Search this conversation<input ref={timelineSearch} autoFocus value={timelineQuery} onChange={e => setTimelineQuery(e.target.value)} /></label><div className="agent-timeline-results">{timelineMatches.length ? timelineMatches.map(item => <button key={item.id} onClick={() => findMessage(item.id)}><small>{item.kind === "user" ? "You" : current?.agentName}</small><span>{item.text.slice(0, 160)}</span></button>) : <div className="agent-search-empty"><p role="status">{timelineQuery ? `No messages match “${timelineQuery}”.` : "No messages in this conversation yet."}</p>{timelineQuery && <button className="agent-button" onClick={() => { setTimelineQuery(""); timelineSearch.current?.focus() }}>Clear search</button>}</div>}</div></section></div>}
    {customSetup && <CustomAgentSetup key={customSetup.id} agent={customSetup} serverName={hosts.find(server => hostKey(server) === customSetup.hostKey)?.name || hostLabel(customSetup.hostKey)} connected={connected && host === customSetup.hostKey} onTest={agent => callbacks.current.onCheck(agent.id, undefined, agent, true)} onClose={() => setCustomSetup(null)} onSave={agent => {
      setPrefs(old => ({ ...old, customAgents: { ...old.customAgents, [agent.hostKey]: [...(old.customAgents[agent.hostKey] || []).filter(row => row.id !== agent.id), agent] } }))
      setCustomSetup(null)
    }} />}
    {removingCustom && <div className="agent-confirm-backdrop"><div className="agent-modal" role="alertdialog" aria-modal="true" aria-labelledby="remove-custom-heading"><h2 id="remove-custom-heading">Remove {removingCustom.name}?</h2><p>Existing history and running executions stay available. To start another execution, you will need to configure this agent again.</p><div className="agent-inline-actions"><button className="agent-button" onClick={() => setRemovingCustom(null)}>Cancel</button><button className="agent-primary" onClick={() => {
      const removed = removingCustom
      setPrefs(old => ({ ...old, agent: old.agent === removed.id ? AGENTS[0].id : old.agent, customAgents: { ...old.customAgents, [removed.hostKey]: (old.customAgents[removed.hostKey] || []).filter(agent => agent.id !== removed.id) } }))
      setRemovingCustom(null)
    }}>Remove agent</button></div></div></div>}
    {folderOpen && <div className="agent-confirm-backdrop"><section className="agent-modal agent-folder-picker" role="dialog" aria-modal="true" aria-labelledby="agent-project-title"><div className="agent-modal-heading"><div><h2 id="agent-project-title">Choose a project</h2><p>A folder on the server where your agent will work.</p></div><button className="agent-icon-button" aria-label="Close project picker" onClick={closeFolder}><AgentIcon name="close" /></button></div>
      {addingServer ? <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const port = Number(data.get("port")), hostname = String(data.get("hostname") || "").trim(), username = String(data.get("username") || "").trim(); if (!hostname || !username || !Number.isInteger(port) || port < 1 || port > 65535) return; const key = JSON.stringify([hostname.toLowerCase(), port, username]); const profile = sessionForHost(key, hosts); folderOperation.current++; setFolderHost(key); if (profile) onSelectHost?.({ ...profile, authMethod: data.get("auth") === "key" ? "key" : "ask" }); setAddingServer(false) }}><label className="agent-field">Host<input required name="hostname" placeholder="server.example.com" /></label><div className="agent-server-fields"><label className="agent-field">Username<input required name="username" placeholder="dev" /></label><label className="agent-field">Port<input required type="number" min={1} max={65535} name="port" defaultValue="22" /></label></div><label className="agent-field">Authentication<select name="auth"><option value="ask">Password or saved credential</option><option value="key">Private key</option></select></label><div className="agent-inline-actions"><button className="agent-primary">Use this server</button><button type="button" className="agent-button" onClick={() => setAddingServer(false)}>Back</button></div></form> : <form onSubmit={e => { e.preventDefault(); void openFolder() }}><label className="agent-field">Server<select aria-label="Project server" value={folderHost} disabled={busy} onChange={e => { folderOperation.current++; setFolderHost(e.target.value); if (e.target.value) selectHost(e.target.value) }}><option value="">Choose a server</option>{hosts.map(s => <option key={hostKey(s)} value={hostKey(s)}>{s.name} · {s.username}@{s.host}</option>)}</select></label><button type="button" className="agent-link-button" disabled={busy} onClick={() => setAddingServer(true)}>Add a server</button><label className="agent-field">Remote project folder<input required autoComplete="off" aria-label="Remote project folder" disabled={busy} value={folderPath} onChange={e => { folderOperation.current++; setFolderPath(e.target.value) }} placeholder="~/projects/my-app" /></label>{folderHost === host && connectionNotice}{error && <p className="agent-error" role="alert">{error}</p>}<div className="agent-inline-actions"><button className="agent-primary" disabled={busy || !connected || folderHost !== host || !folderPath.trim()}>Open folder</button><button type="button" className="agent-button" onClick={closeFolder}>Cancel</button></div></form>}
    </section></div>}
    {deleting && <div className="agent-confirm-backdrop"><section className="agent-modal agent-confirm" role="alertdialog" aria-modal="true" aria-labelledby="agent-delete-title"><h2 id="agent-delete-title">Delete this conversation?</h2><p>“{threadTitle(deleting)}” will be removed from Still. Project files, terminal sessions, and the agent’s own saved history are kept.</p>{deleting.turnActive && <p>Stop the agent before deleting this conversation.</p>}{error && <p className="agent-error" role="alert">{error}</p>}<div className="agent-inline-actions"><button className="agent-button" onClick={() => setDeleting(null)}>Cancel</button>{deleting.turnActive ? <button className="agent-primary" disabled={busy} onClick={() => void run(async () => { await cancelAgentTurn(deleting.executionId); setDeleting(null) })}>Stop agent</button> : <button className="agent-danger" disabled={busy} onClick={() => void run(async () => { await deleteAgentThread(deleting.executionId); if (selected === deleting.meta.id) home(); setDeleting(null) })}>Delete conversation</button>}</div></section></div>}
  </section>
}
