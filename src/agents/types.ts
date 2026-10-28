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
  | "agentRequest"
  | "requestOutcome"

export interface AgentHistoryCapabilities { revert: boolean; retry: boolean }

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
  sequence: number
  attemptId?: string
  endSequence?: number
  type: AgentEventType
  state?: AgentThreadState
  text?: string
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
  remoteCursor?: number
  turnActive?: boolean
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
export interface AgentLaunchOptions { cwd?: string; executable?: string; resumeSessionId?: string; conversationId?: string }
export interface AgentAvailability { agentId: string; executable?: string; available: boolean; installed: boolean; runtime: "native" | "acp"; runtimeAvailable: boolean; message?: string }

export interface AgentThreadSnapshot {
  conversationId?: string
  hostKey?: string
  executionId: string
  localSessionId: string
  agentId: string
  agentName: string
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
  remoteCursor?: number
  promptId?: string | number
}

export interface AgentLibrary {
  rows: unknown[]
  workspaces: Record<string, unknown>
  storagePath: string
  warnings: string[]
  liveExecutions?: string[]
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
