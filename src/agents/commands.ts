import type { AgentCommand, AgentConfigOption } from "./types"

/** Native TUI names checked against OpenCode v2.0.29 (042d0832).
 * Still actions have explicit scope; server registrations always take precedence.
 */
export const workspaceCommands: AgentCommand[] = [
  { name: "new", description: "Start a new conversation", route: "client", source: "Still" },
  { name: "sessions", aliases: ["resume", "continue"], description: "Search conversations saved on this device", route: "client", source: "Still" },
  { name: "open", aliases: ["projects", "project"], description: "Choose a project folder", route: "client", source: "Still" },
  { name: "models", description: "Choose a model", route: "client", source: "Still" },
  { name: "agents", description: "Choose the provider's agent or conversation mode", route: "client", source: "Still" },
  { name: "variants", aliases: ["thinking", "effort"], description: "Choose a model's reasoning level", route: "client", source: "Still" },
  { name: "refresh-session", aliases: ["refresh"], description: "Refresh this conversation's models, settings, and session state", route: "client", source: "Still" },
  { name: "providers", description: "Choose a coding agent for a new conversation", route: "client", source: "Still" },
  { name: "skills", description: "Browse available project skills", route: "client", source: "Still" },
  { name: "rename", description: "Rename this conversation in Still", route: "client", source: "Still", input: { hint: "Optional conversation name" } },
  { name: "copy", description: "Copy the saved conversation as Markdown", route: "client", source: "Still" },
  { name: "timeline", description: "Find a message in this conversation", route: "client", source: "Still" },
  { name: "help", description: "Browse commands and availability details", route: "client", source: "Still" },
]
export const openCodeTuiCommands: AgentCommand[] = [
  ["clear", "Clear the OpenCode session", "Still keeps each saved conversation intact. Use /new to start another conversation."],
  ["undo", "Undo the previous message", "OpenCode history undo is not connected to Still's local timeline yet. Use the OpenCode TUI for this action."],
  ["redo", "Redo an undone message", "OpenCode history redo is not connected to Still's local timeline yet. Use the OpenCode TUI for this action."],
  ["editor", "Open the terminal's external editor", "This command requires OpenCode's terminal editor integration."],
  ["btw", "Ask a side question without changing context", "The OpenCode side-question view is not connected to Still yet."],
  ["highlights", "Show OpenCode release highlights", "Release highlights are a native OpenCode TUI view."],
  ["connect", "Connect an OpenCode integration", "Sign in using opencode auth login on the execution host. Still uses those credentials."],
  ["mcps", "Manage OpenCode MCP servers", "MCP configuration is owned by OpenCode. Use opencode mcp on the execution host."],
  ["plugins", "Manage OpenCode plugins", "Use opencode plugin on the execution host. Server command registrations are loaded here automatically; TUI plugin interfaces remain in OpenCode."],
  ["worktrees", "Manage OpenCode workspaces", "Use OpenCode's workspace manager, then add the selected worktree folder as a Still project."],
  ["cd", "Change the current provider-session directory", "A Still conversation keeps its execution folder. Start a new conversation in the intended project."],
  ["fork", "Fork the provider session", "Forking provider history into a new local conversation is not connected yet."],
  ["share", "Share the provider session", "Sharing is not exposed by this OpenCode connection."],
  ["export", "Export the provider-owned transcript", "Provider history export remains in OpenCode. /copy copies Still's saved transcript."],
  ["status", "View OpenCode runtime status", "OpenCode's native status view is available in its TUI. Still shows its connection and execution status in this workspace."],
  ["debug", "View OpenCode debug information", "Run opencode debug on the execution host for native diagnostics."],
  ["stats", "View OpenCode usage statistics", "Run opencode stats on the execution host for native usage information."],
  ["diff", "Open the project-wide diff viewer", "Project-wide VCS browsing remains in OpenCode. Changes supplied by the agent appear in Still's tool activity."],
  ["themes", "Switch OpenCode's terminal theme", "OpenCode's terminal theme does not change Still's interface."],
  ["pair", "Pair another device with OpenCode", "Run opencode pair on the execution host to pair with OpenCode's own server."],
  ["restart", "Restart the OpenCode background service", "Still owns its agent connection. Restart the independent background service using opencode service restart."],
  ["update", "Update OpenCode", "Run opencode upgrade on the execution host to update the installed CLI."],
  ["exit", "Exit the OpenCode terminal app", "Close the Agents workspace to return to Still. This does not quit a separate OpenCode TUI."],
].map(([name, description, unavailable]) => ({ name, description, unavailable, source: "OpenCode TUI", ...(name === "pair" ? { aliases: ["web"] } : name === "exit" ? { aliases: ["quit", "q"] } : {}) }))

export function commandInventory(provider: AgentCommand[], agentId: string, extraControls: AgentConfigOption[] = []): AgentCommand[] {
  const names = new Set(provider.map(command => command.name))
  return [...provider, ...workspaceCommands.filter(command => !names.has(command.name)), ...extraControls.map(option => ({ name: `configure:${option.id}`, description: `Configure ${option.name}${option.description ? ` · ${option.description}` : ""}`, route: "client" as const, source: "Still", configId: option.id })).filter(command => !names.has(command.name)), ...(agentId === "opencode" ? openCodeTuiCommands.filter(command => !names.has(command.name)) : [])]
}
