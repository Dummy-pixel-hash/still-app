import React from "react"
import { createRoot } from "react-dom/client"
import "../src/styles/theme.css"
import MobileApp from "../src/mobile/MobileApp"
import { registerNativeBridge } from "../src/bridge/nativeBridge"
import { mockBridge } from "../src/bridge/mockBridge"
import { hostKey, readLibraryPreferences } from "../src/agents/workspace"
import type { AgentLibrary, AgentThreadSnapshot } from "../src/agents/types"
import type { Session } from "../src/types"

// Fixture-only records. Neither the app entry nor the Android build imports this.
const server: Session = { id: "mobile-test-server", name: "Fixture server", host: "example.invalid", port: 22, username: "fixture", projectId: "", workingDirectory: "", authMethod: "ask", remember: false, tmuxSession: "", createdAt: 1, updatedAt: 1 }
const host = hostKey(server), now = Date.now()
const specs = [["review", "Refine project navigation", "opencode", "OpenCode"], ["reconnect", "Fix reconnect after sleep", "claude", "Claude Code"], ["shortcuts", "Add keyboard shortcuts", "codex", "Codex"]]
const rows = new URLSearchParams(location.search).has("empty") ? [] : specs.map(([id, title, agentId, agentName], index) => ({
  conversationId: id, executionId: id, localSessionId: server.id, hostKey: host, cwd: "/srv/still", agentId, agentName,
  state: "complete", lastSequence: 2, turnActive: false, configOptions: [], persistent: true,
  meta: { id, title, hostKey: host, folder: "/srv/still", createdAt: now, activityAt: now - index * 60000, order: index, pinned: false, draft: "" },
  transcript: [{ type: "userMessage", sequence: 1, text: "Keep the remote work intact.", messageId: `m-${id}` }, { type: "assistantMessage", sequence: 2, text: "I’ll keep the changes focused and verify the existing behavior." }, ...(index === 0 ? [{ type: "agentRequest", sequence: 3, request: { requestId: "fixture-question", kind: "question", title: "Choose a navigation structure" } }] : [])],
}))
const saved: AgentLibrary = { rows, workspaces: { library: { ...readLibraryPreferences(), projects: [{ host, folder: "/srv/still" }], servers: [server] } }, storagePath: "fixture://mobile-history", warnings: [] }
const snapshots = new Map(rows.map(row => [row.executionId, row as AgentThreadSnapshot]))
registerNativeBridge({ ...mockBridge,
  agentLibrary: async () => saved,
  agentMigrate: async () => [],
  agentFlush: async () => {},
  agentSaveWorkspace: async (key, value) => { saved.workspaces[key] = value },
  agentSaveMetadata: async () => {},
  agentSnapshot: async id => snapshots.get(id)!,
  subscribeToAgent: async () => () => {},
})
createRoot(document.getElementById("root")!).render(<MobileApp />)
