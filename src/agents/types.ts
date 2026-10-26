export type AgentThreadState =
  | "connecting"
  | "working"
  | "inputRequired"
  | "complete"
  | "cancelled"
  | "error"
  | "submissionUnknown"

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
  options: AgentPermissionOption[]
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
}

export interface AgentPlanEntry { content: string; status: string; priority?: string }
export interface AgentCommand { name: string; description: string; input?: { hint: string } }
export type AgentToolContent =
  | { type: "content"; content: { type: string; text?: string } }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
export interface AgentLaunchOptions { cwd?: string; executable?: string }
export interface AgentAvailability { agentId: string; executable?: string; available: boolean }

export interface AgentThreadSnapshot {
  executionId: string
  localSessionId: string
  agentId: string
  agentName: string
  agentSessionId?: string
  cwd: string
  state: AgentThreadState
  transcript: AgentThreadEvent[]
  pendingPermission?: AgentPermissionRequest
  lastError?: string
  lastSequence: number
  turnActive: boolean
  configOptions: AgentConfigOption[]
  commands?: AgentCommand[]
}

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

/** First manually installed ACP v1 agent adapters validated by the adapter source documentation. */
export const AGENTS: readonly AgentDefinition[] = [
  { id: "opencode", label: "OpenCode", launchKind: "native", executable: "opencode", args: ["acp"], installHint: "OpenCode installed on the remote server", installCommand: "npm install -g opencode-ai", loginCommand: "opencode auth login", note: "Native ACP. Credentials and project files stay on the server." },
  { id: "pi", label: "Pi", launchKind: "adapter", executable: "pi-acp", args: [], installHint: "Pi and pi-acp installed on the remote server", installCommand: "npm install -g @mariozechner/pi-coding-agent pi-acp", loginCommand: "pi", note: "Community adapter. Open Pi and use /login. Tools may run without asking for approval." },
  { id: "codex", label: "Codex", launchKind: "adapter", executable: "codex-acp", args: [], installHint: "@agentclientprotocol/codex-acp installed on the remote server", installCommand: "npm install -g @openai/codex @agentclientprotocol/codex-acp", loginCommand: "codex login --device-auth", note: "ACP-maintained adapter, backed by Codex App Server. Sign in on the server." },
  { id: "claude", label: "Claude Code", launchKind: "adapter", executable: "claude-agent-acp", args: [], installHint: "@agentclientprotocol/claude-agent-acp installed on the remote server", installCommand: "npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp", loginCommand: "claude auth login", note: "Claude Agent SDK adapter. Authentication belongs on the server, not in Still." },
  { id: "gemini", label: "Gemini CLI", launchKind: "native", executable: "gemini", args: ["--acp"], installHint: "Gemini CLI with ACP support installed on the remote server", installCommand: "npm install -g @google/gemini-cli", loginCommand: "gemini", note: "Native ACP. Open Gemini in the server terminal to complete sign-in first." },
]
