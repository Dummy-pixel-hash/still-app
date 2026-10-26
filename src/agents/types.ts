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
}

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
}

export interface AgentDefinition {
  id: string
  label: string
  launchKind: "native" | "adapter"
  executable: string
  args: readonly string[]
  installHint: string
  note: string
}

/** First manually installed ACP v1 agent adapters validated by the adapter source documentation. */
export const AGENTS: readonly AgentDefinition[] = [
  { id: "opencode", label: "OpenCode", launchKind: "native", executable: "opencode", args: ["acp"], installHint: "OpenCode installed on the remote server", note: "Native ACP. Credentials and project files stay on the server." },
  { id: "pi", label: "Pi", launchKind: "adapter", executable: "pi-acp", args: [], installHint: "pi-acp installed on the remote server", note: "Community adapter. Pi tools use the remote account's host permissions and may not ask before each operation." },
  { id: "codex", label: "Codex", launchKind: "adapter", executable: "codex-acp", args: [], installHint: "@agentclientprotocol/codex-acp installed on the remote server", note: "Current ACP-maintained Codex adapter. Its provider login belongs on the server." },
  { id: "claude", label: "Claude Code", launchKind: "adapter", executable: "claude-agent-acp", args: [], installHint: "@agentclientprotocol/claude-agent-acp installed on the remote server", note: "Claude Agent SDK ACP adapter. Sign into the agent on the server first." },
  { id: "gemini", label: "Gemini CLI", launchKind: "native", executable: "gemini", args: ["--acp"], installHint: "Gemini CLI with ACP support installed on the remote server", note: "Gemini CLI's documented stdio ACP mode." },
]
