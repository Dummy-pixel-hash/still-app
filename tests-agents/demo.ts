import { AGENTS, type AgentThreadEvent, type AgentThreadSnapshot } from "../src/agents/types"
import { hostKey, type AgentLibraryPreferences, type ConversationMeta } from "../src/agents/workspace"
import type { Session } from "../src/types"

/** Authored, synthetic history for the explicitly labelled public UI preview. */
export function createAgentDemo(session: Session) {
  const now = Date.now(), host = hostKey(session)
  const examples = [
    { folder: "/srv/still", agent: "opencode", title: "Refine project navigation", minutes: 3 },
    { folder: "/srv/still", agent: "claude", title: "Fix reconnect on wake", minutes: 28 },
    { folder: "/srv/still", agent: "codex", title: "Add keyboard shortcuts", minutes: 144 },
    { folder: "/srv/still", agent: "pi", title: "Explore the storage layer", minutes: 1440 },
    { folder: "/srv/documentation", agent: "claude", title: "Write the setup guide", minutes: 1450 },
    { folder: "/srv/documentation", agent: "opencode", title: "Document remote agents", minutes: 2800 },
    { folder: "/srv/api-service", agent: "codex", title: "Trace slow API responses", minutes: 4300 },
    { folder: "/srv/api-service", agent: "pi", title: "Paginate event history", minutes: 5700 },
  ]
  const rows = examples.map((example, index): AgentThreadSnapshot & { meta: ConversationMeta } => {
    const id = `demo-conversation-${index + 1}`
    const historySupported = ["opencode", "pi", "codex"].includes(example.agent)
    const messageId = `${id}:example-message`
    const events: Omit<AgentThreadEvent, "sequence">[] = [
      { type: "userMessage", messageId, ...(historySupported ? { checkpoint: { provider: example.agent, id: messageId, synthetic: true } } : {}), text: index === 0 ? "Make the sidebar easier to scan. Keep related conversations together and make the keyboard shortcuts work on both platforms." : example.title },
    ]
    if (index === 0) {
      events.push(
        { type: "toolStart", toolCallId: "read", title: "Read workspace navigation", toolKind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "Read src/agents/navigation.ts and src/styles/sidebar.css" } }] },
        { type: "toolStart", toolCallId: "keyboard", title: "Update keyboard navigation", toolKind: "edit", status: "completed", content: [{ type: "diff", path: "src/agents/navigation.ts", oldText: 'export function handleShortcut(event: KeyboardEvent) {\n  if (event.ctrlKey && event.key === "k") {\n    openSearch();\n  }\n}\n', newText: 'export function handleShortcut(event: KeyboardEvent) {\n  const modifier = event.ctrlKey || event.metaKey;\n\n  if (modifier && event.key === "k") {\n    event.preventDefault();\n    openSearch({ focus: true });\n  }\n}\n' }] },
        { type: "toolStart", toolCallId: "styles", title: "Refine project rows", toolKind: "edit", status: "completed", content: [{ type: "diff", path: "src/styles/sidebar.css", oldText: ".project-row {\n  min-height: 57px;\n  padding: 12px;\n}\n", newText: ".project-row {\n  min-height: 35px;\n  padding: 8px;\n  border-radius: 7px;\n}\n" }] },
        { type: "assistantChunk", text: "### Project navigation, simplified\n\nEach project now has a compact list of conversations, with a clear selected state and recent activity alongside it.\n\n- **One navigation column.** Projects and conversations share the available width.\n- **Actions where you need them.** Rename, pin, and archive are in the row menu.\n- **Keyboard-friendly search.** The shortcut accepts either Control or Command and focuses the search field.\n\nThe two example file edits are ready to inspect in **Changes**." },
      )
    } else {
      const replies = [
        "",
        "### Reconnect after sleep\n\nThe connection should recover independently of the terminal view. I’d start with the SSH worker’s reconnect policy, then check that reopening a conversation restores its current state.\n\nThe important cases are a brief network interruption, a laptop wake, and a server that has restarted.",
        "### Keyboard navigation\n\nLet’s make the most frequent actions available from the keyboard: opening search, creating a conversation, and collapsing project navigation.\n\nFocus should return to the control that opened a menu when that menu closes.",
        "### Where history lives\n\nStill owns the local conversation record. The remote provider owns execution and its resume identifier. Keeping those responsibilities distinct makes offline reading possible.\n\nI’ll follow a received event from the provider bridge into its durable journal and then into the conversation view.",
        "### Getting started\n\n1. Add your server and verify its host key.\n2. Choose the project folder deliberately.\n3. Select an installed coding agent.\n4. Start a conversation.\n\nYour saved conversations stay available on this device when the server is offline.",
        "### Remote execution\n\nThe server needs the selected agent and its runtime. Still discovers the available integration and reads the provider’s model and command catalog where supported.\n\nInstallation, authentication, and successful inference are separate states in the setup flow.",
        "### Follow the slow request\n\nStart with a request trace rather than changing the database query immediately. Compare time spent in the handler, external services, and response serialization.\n\nThen use the slowest span to choose the next measurement.",
        "### Cursor-based history\n\nUse a stable event identifier as the cursor. New events can arrive while someone reads an older page, so preserving the reader’s position is more important than keeping them at the bottom.\n\nLoading earlier activity should retain the same visible message and offset.",
      ]
      events.push({ type: "assistantChunk", text: replies[index] })
    }
    events.push({ type: "threadComplete" })
    const at = now - example.minutes * 60000
    return {
      conversationId: id, executionId: id, localSessionId: session.id, hostKey: host,
      agentId: example.agent, agentName: AGENTS.find(agent => agent.id === example.agent)!.label,
      agentSessionId: `synthetic-provider-${index + 1}`, cwd: example.folder, state: "saved", turnActive: false,
      transcript: events.map((event, sequence) => ({ ...event, sequence: sequence + 1, attemptId: id })),
      lastSequence: events.length, configOptions: [], resumable: true,
      historyCapabilities: { revert: historySupported, retry: historySupported },
      meta: { id, hostKey: host, folder: example.folder, title: example.title, pinned: false, createdAt: at, activityAt: at, order: at, draft: "" },
    }
  })
  const library: AgentLibraryPreferences = {
    projects: [...new Set(examples.map(example => example.folder))].map(folder => ({ host, folder })),
    sidebarCollapsed: false, sort: "recent", collapsed: [], drafts: {}, agent: "opencode", executables: {}, servers: [session],
  }
  return { rows, workspaces: { library }, deleted: [] as string[] }
}
