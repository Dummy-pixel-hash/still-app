import { AGENTS, type AgentDefinition, type CustomAgent } from "./types"

const bytes = (value: string) => new TextEncoder().encode(value).length

export function customAgentError(agent: CustomAgent, host: string): string | undefined {
  if (!host || agent.hostKey !== host) return "Choose the server this agent belongs to."
  if (!/^custom-[a-zA-Z0-9-]{1,80}$/.test(agent.id)) return "Invalid custom agent identity."
  if (!agent.name.trim() || [...agent.name].length > 80 || /[\x00-\x1f\x7f]/.test(agent.name)) return "Enter a name of up to 80 characters."
  if (!agent.executable || bytes(agent.executable) > 4096 || /[\x00-\x1f\x7f]/.test(agent.executable)
    || (!agent.executable.startsWith("/") && !/^[a-zA-Z0-9_.+-]+$/.test(agent.executable))) return "Use a command on PATH or an absolute remote executable path, without shell arguments."
  if (agent.transport !== "acp-v1") return "This integration requires ACP over stdio."
  if (!Array.isArray(agent.args) || agent.args.length > 64 || agent.args.some(arg => typeof arg !== "string" || bytes(arg) > 4096 || arg.includes("\0"))
    || agent.args.reduce((size, arg) => size + bytes(arg), 0) > 16384) return "Use up to 64 arguments (16 KiB total), without null characters."
}

export function isCustomAgent(value: unknown, host: string): value is CustomAgent {
  if (!value || typeof value !== "object") return false
  const agent = value as CustomAgent
  return typeof agent.id === "string" && typeof agent.name === "string" && typeof agent.executable === "string"
    && !customAgentError(agent, host)
}

export function agentsForHost(host: string, customAgents: Record<string, CustomAgent[]>): readonly AgentDefinition[] {
  return [...AGENTS, ...(customAgents[host] || []).map(agent => ({
    id: agent.id, label: agent.name, launchKind: "native" as const, executable: agent.executable, args: agent.args,
    installHint: "Install and sign in to this ACP agent on the server.", installCommand: "", loginCommand: "",
    note: "Custom agent · ACP over stdio",
  }))]
}

export function customLaunchOptions(agentId: string, host: string, agents: Record<string, CustomAgent[]>, saved?: CustomAgent) {
  if (!agentId.startsWith("custom-")) return undefined
  const configured = agents[host]?.find(agent => agent.id === agentId)
  if (!configured) throw new Error("This custom agent was removed. Add it again in Agent settings before starting a new execution. Existing history is still available.")
  // Resuming a conversation uses its original launch, never a silently edited command.
  return saved || configured
}
