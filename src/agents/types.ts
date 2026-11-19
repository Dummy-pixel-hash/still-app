export type AgentThreadState =
  | "connecting"
  | "working"
  | "inputRequired"
  | "complete"
  | "cancelled"
  | "error"
  | "submissionUnknown"
  | "rewinding"
  | "saved"
  | "detached"

export type AgentEventType =
  | "userMessage"
  | "assistantChunk"
  | "assistantMessage"
  | "toolStart"
  | "toolUpdate"
  | "permission"
  | "threadState"
  | "threadComplete"
  | "threadError"
  | "threadStopped"
  | "configOptions"
  | "reasoningChunk"
  | "plan"
  | "commands"
  | "input"
  | "notice"
  | "messageCheckpoint"
  | "historyReverted"
  | "historyCapabilities"
  | "chatTitle"
  | "agentRequest"
  | "requestOutcome"
  | "todos"
  | "capabilities"
  | "subagentRequest"
  | "subagentReply"

export interface AgentHistoryCapabilities { revert: boolean; retry: boolean }
export type AgentTodoStatus = "pending" | "completed"
export interface AgentTodoItem {
  id: string
  title: string
  status: AgentTodoStatus
  createdBy: "user" | "agent"
  updatedBy: "user" | "agent"
  createdAt?: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
  detail?: string
}
export interface AgentTodoSnapshot { protocolVersion: number; revision: number; items: AgentTodoItem[]; activeId?: string; toolAvailable: boolean; available: boolean }
/** Observation of the shared list; never an agent turn or execution status. */
export interface AgentTodoSync { state: "current" | "stale" | "conflict" | "unavailable"; reason?: string }

/** Provider protocol the worker actually speaks; never inferred from the display name. */
export type AgentProviderTransport = "http-v2+sse" | "codex-app-server" | "claude-stream-json" | "pi-rpc" | "acp-v1"
export interface AgentProviderRuntime {
  transport: AgentProviderTransport
  executable?: string
  version?: string
  versionSource?: "runtime" | "executable"
  versionObservedAt?: number
}
/** `unsupported` describes the integration, not the provider's general ability. */
export type AgentCapabilityKey = "sharedTodos" | "providerPlans" | "providerTaskProjection" | "clientTodoWrite"
export type AgentFeatureStatus = "supported" | "unsupported" | "unverified"
/** `advertised` proves a connected route; only `observed` reflects an acknowledged operation. */
export type AgentFeatureEvidence = "adapter" | "advertised" | "observed"
export interface AgentFeatureSupport { status: AgentFeatureStatus; reason: string; evidence?: AgentFeatureEvidence }
/** Worker wire reports omit `freshness`; only the native observer may call an observation current. */
export interface AgentCapabilityReport {
  schemaVersion: 1
  executionId: string
  agentSessionId: string
  cwd: string
  configGeneration: number
  observedAt: number
  providerRuntime: AgentProviderRuntime
  features: Record<AgentCapabilityKey, AgentFeatureSupport>
  freshness: "current" | "stale"
}

export interface AgentPermissionOption {
  optionId: string
  name: string
  kind: string
}

export interface AgentPermissionRequest {
  requestId: string | number
  sessionId: string
  toolCallId: string
  title: string
  description?: string
  command?: string
  rawInput?: Record<string, unknown>
  content?: AgentToolContent[]
  options: AgentPermissionOption[]
}

export type AgentRequestKind = "question" | "permission"
export type AgentRequestOutcomeKind = "answered" | "dismissed" | "approved" | "rejected" | "cancelled" | "uncertain"
export interface AgentRequestSummary {
  requestId: string | number
  kind: AgentRequestKind
  title: string
}
export interface AgentRequestOutcome {
  requestId: string | number
  kind: AgentRequestKind
  title: string
  outcome: AgentRequestOutcomeKind
  responseLabel?: string
}

export interface AgentConfigOptionValue { value: string; name: string; description?: string }
export interface AgentConfigOption {
  id: string
  name: string
  description?: string
  category?: string
  type: string
  currentValue: string | boolean
  options?: Array<AgentConfigOptionValue | { name: string; options: AgentConfigOptionValue[] }>

}
export interface AgentThreadEvent {
  previewTruncated?: boolean
  sequence: number
  attemptId?: string
  endSequence?: number
  type: AgentEventType
  state?: AgentThreadState
  text?: string
  source?: "user" | "parentAgent"
  toolCallId?: string
  title?: string
  detail?: string
  status?: string
  permission?: AgentPermissionRequest
  configOptions?: AgentConfigOption[]
  plan?: AgentPlanEntry[]
  commands?: AgentCommand[]
  content?: AgentToolContent[]
  messageId?: string
  toolKind?: string
  rawInput?: Record<string, unknown>
  rawOutput?: unknown
  locations?: Array<{ path: string; line?: number }>
  input?: AgentInputRequest
  outputDelta?: string
  checkpoint?: Record<string, unknown>
  historyCapabilities?: AgentHistoryCapabilities
  request?: AgentRequestSummary
  requestOutcome?: AgentRequestOutcome
  todos?: AgentTodoSnapshot
  todoSync?: AgentTodoSync
  capabilities?: AgentCapabilityReport
  subagentRequest?: { requestId: string; input: Record<string, unknown> }
  remoteCursor?: number
  turnActive?: boolean
  recoveryReason?: "workerUnavailable"
}

export interface AgentInputField {
  title?: string
  description?: string
  type?: string
  enum?: string[]
  oneOf?: Array<{ const: string; title?: string; description?: string }>
  items?: { enum?: string[]; oneOf?: Array<{ const: string; title?: string; description?: string }> }
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}
export interface AgentInputRequest {
  requestId: string | number
  title: string
  schema: { properties?: Record<string, AgentInputField>; required?: string[] }
}

export interface AgentPlanEntry { content: string; status: string; priority?: string }
export interface AgentCommand { name: string; aliases?: string[]; description: string; input?: { hint: string }; source?: string; route?: "command" | "skill" | "client"; unavailable?: string; configId?: string }
export type AgentToolContent =
  | { type: "content"; content: { type: string; text?: string } }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "patch"; path: string; patch: string }
export interface CustomAgent {
  id: string
  hostKey: string
  name: string
  executable: string
  args: string[]
  transport: "acp-v1"
}
export interface AgentLaunchOptions { cwd?: string; executable?: string; resumeSessionId?: string; conversationId?: string; customAgent?: CustomAgent; parentConversationId?: string }
export interface AgentAvailability { agentId: string; executable?: string; available: boolean; installed: boolean; runtime: "native" | "acp"; runtimeAvailable: boolean; message?: string; providerRuntime?: AgentProviderRuntime; checkedAt?: number }

export interface AgentThreadSnapshot {
  historyLoaded?: boolean
  historyBefore?: number | null
  historyAfter?: number | null
  conversationId?: string
  parentConversationId?: string
  hostKey?: string
  executionId: string
  localSessionId: string
  agentId: string
  agentName: string
  customAgent?: CustomAgent
  agentSessionId?: string
  cwd: string
  state: AgentThreadState
  transcript: AgentThreadEvent[]
  pendingPermission?: AgentPermissionRequest
  pendingInput?: AgentInputRequest
  lastError?: string
  lastSequence: number
  turnActive: boolean
  configOptions: AgentConfigOption[]
  commands?: AgentCommand[]
  resumable?: boolean
  historyCapabilities?: AgentHistoryCapabilities
  /** Full active message identities supplied by a live native snapshot. */
  activeMessageIds?: string[]
  persistent?: boolean
  continuity?: boolean
  remoteImported?: boolean
  configGeneration?: number
  pendingMessageId?: string
  remoteCursor?: number
  promptId?: string | number
  /** Confirmed worker loss, distinct from an SSH disconnection. */
  recoveryReason?: "workerUnavailable"
  recoveryRequired?: boolean
  todos?: AgentTodoSnapshot
  todoSync?: AgentTodoSync
  capabilities?: AgentCapabilityReport
}

export interface AgentLibrary {
  rows: unknown[]
  workspaces: Record<string, unknown>
  storagePath: string
  warnings: string[]
  liveExecutions?: string[]
}

export interface AgentHistoryPage {
  executionId: string
  lastSequence: number
  transcript: AgentThreadEvent[]
  before: number | null
  after: number | null
  total: number
  latest: boolean
}

export interface AgentChangeIndexItem {
  id: string
  path: string
  toolCallId: string
  outcome: "completed" | "failed" | "pending" | "unconfirmed"
}
export interface AgentChangeHistory { executionId: string; changes: AgentChangeIndexItem[] }
export interface AgentChangeDetails { executionId: string; path: string; events: AgentThreadEvent[] }

export interface SharedConversation {
  serverAccountId: string
  conversationId: string
  executionId: string
  generation: number
  revision: number
  catalogRevision: number
  fields: Record<"title" | "pinned" | "archivedAt" | "order", number>
  values: { title: string; titleSource: "prompt" | "agent" | "user"; pinned: boolean; archivedAt: number | null; order: number }
  readThroughSeq: number
  conversationSeq: number
  executionOffset?: number
  prepared?: boolean
  projectId: string
  deleted?: boolean
}
export interface SharedProject { id: string; cwd: string; name: string; order: number; revision: number; deleted?: boolean }
export interface SharedOperation {
  operationId: string
  kind: "organization.patch" | "read.advance" | "project.patch" | "project.reorder" | "project.delete" | "conversation.delete"
  serverAccountId: string
  expectedCatalogRevision: number
  conversationId?: string
  executionId?: string
  expectedGeneration?: number
  cwd: string
  patch?: Record<string, unknown>
  expectedFields?: Partial<SharedConversation["fields"]>
  expectedRevision?: number
  readThroughSeq?: number
  projectId?: string
  order?: Array<{ id: string; revision: number }>
}
export interface SharedOperationResult { ok: boolean; code?: string; message?: string; current?: SharedConversation; project?: SharedProject; projects?: SharedProject[] }
export interface LegacyAgentRecord { executionId: string; reason: string }
export interface SharedLibraryPage {
  protocolVersion: number
  catalogVersion?: number
  serverAccountId: string
  revision?: number
  hostKey?: string
  projects?: SharedProject[]
  tombstones?: string[]
  rows: Array<{ conversationId: string; executionId: string; cwd: string; protocolVersion: number; shared?: SharedConversation; activityAt?: number }>
  warnings: string[]
  legacyRecords?: LegacyAgentRecord[]
  /** Directories without a committed state record; not proof of worker death. */
  incompleteExecutions?: string[]
  next: string | null
}

export interface AgentCatalog { commands: AgentCommand[]; configOptions: AgentConfigOption[]; version?: string; warning?: string }

export interface AgentDefinition {
  id: string
  label: string
  launchKind: "native" | "adapter"
  executable: string
  args: readonly string[]
  installHint: string
  note: string
  installCommand: string
  loginCommand: string
}

/** Installed base CLIs; the native host negotiates actual capabilities at connection time. */
export const AGENTS: readonly AgentDefinition[] = [
  { id: "opencode", label: "OpenCode", launchKind: "native", executable: "opencode", args: ["serve"], installHint: "OpenCode v2 installed on the remote server", installCommand: "npm install -g @opencode/cli", loginCommand: "opencode auth login", note: "Uses your installed OpenCode v2 server and the commands in this project." },
  { id: "pi", label: "Pi", launchKind: "native", executable: "pi", args: ["--mode", "rpc"], installHint: "Pi installed on the remote server", installCommand: "npm install -g @mariozechner/pi-coding-agent", loginCommand: "pi", note: "Uses your installed Pi through its RPC interface. Sign in with /login in Pi." },
  { id: "codex", label: "Codex", launchKind: "native", executable: "codex", args: ["app-server"], installHint: "Codex CLI installed on the remote server", installCommand: "npm install -g @openai/codex", loginCommand: "codex login --device-auth", note: "Uses your installed Codex App Server and remote account." },
  { id: "claude", label: "Claude Code", launchKind: "native", executable: "claude", args: [], installHint: "Claude Code installed on the remote server", installCommand: "npm install -g @anthropic-ai/claude-code", loginCommand: "claude auth login", note: "Uses your installed Claude Code through structured streaming." },
  { id: "gemini", label: "Gemini CLI", launchKind: "native", executable: "gemini", args: ["--acp"], installHint: "Gemini CLI with ACP support installed on the remote server", installCommand: "npm install -g @google/gemini-cli", loginCommand: "gemini", note: "Native ACP. Open Gemini in the server terminal to complete sign-in first." },
]
