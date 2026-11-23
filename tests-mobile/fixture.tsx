import React, { useEffect } from "react"
import { createRoot } from "react-dom/client"
import "../src/styles/theme.css"
import MobileApp from "../src/mobile/MobileApp"
import { registerNativeBridge } from "../src/bridge/nativeBridge"
import { mockBridge } from "../src/bridge/mockBridge"
import { hostKey, readLibraryPreferences } from "../src/agents/workspace"
import type { AgentLibrary, AgentThreadEvent, AgentThreadSnapshot } from "../src/agents/types"
import type { Session } from "../src/types"

// Fixture-only records. Neither the app entry nor the Android build imports this.
const server: Session = { id: "mobile-test-server", name: "Fixture server", host: "example.invalid", port: 22, username: "fixture", projectId: "", workingDirectory: "", authMethod: "ask", remember: false, tmuxSession: "", createdAt: 1, updatedAt: 1 }
const host = hostKey(server), now = Date.now()
const projectFixture = new URLSearchParams(location.search).has("projects")
const otherServer: Session = { ...server, id: "mobile-test-other-account", name: new URLSearchParams(location.search).has("duplicateServerNames") ? server.name : "Release server", username: "release" }
const otherHost = hostKey(otherServer)
const specs = [["review", "Refine project navigation", "opencode", "OpenCode"], ["reconnect", "Fix reconnect after sleep", "claude", "Claude Code"], ["shortcuts", "Add keyboard shortcuts", "codex", "Codex"]]
const configForAgent = (agentId: string) => {
  const model = agentId === "claude" ? ["claude-sonnet-4-5", "Claude Sonnet 4.5", "Claude Opus 4.5"]
    : agentId === "codex" ? ["gpt-5.1-codex", "GPT-5.1 Codex", "GPT-5 Codex"]
      : ["gpt-5-codex", "GPT-5 Codex", "GPT-5 mini"]
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: model[0], options: [{ value: model[0], name: model[1] }, { value: "alternate", name: model[2] }] },
    { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "code", options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code" }] },
  ]
}
const rows = new URLSearchParams(location.search).has("empty") ? [] : specs.map(([id, title, agentId, agentName], index) => ({
  conversationId: id, executionId: id, localSessionId: server.id, hostKey: host, cwd: "/srv/still", agentId, agentName,
  state: "complete", lastSequence: 2, turnActive: false, configOptions: configForAgent(agentId), persistent: true,
  meta: { id, title, hostKey: host, folder: "/srv/still", createdAt: now, activityAt: now - index * 60000, order: index, pinned: false, draft: index === 0 && new URLSearchParams(location.search).has("chatpill") && !new URLSearchParams(location.search).has("emptydraft") ? "Make the project list easier to scan." : "" },
  transcript: [{ type: "userMessage", sequence: 1, text: "Keep the remote work intact.", messageId: `m-${id}` }, { type: "assistantMessage", sequence: 2, text: "I’ll keep the changes focused and verify the existing behavior." }, ...(index === 0 ? [{ type: "agentRequest", sequence: 3, request: { requestId: "fixture-question", kind: "question", title: "Choose a navigation structure" } }] : [])],
}))
const projects = [{ host, folder: "/srv/still", name: "Still mobile" }, { host, folder: "/srv/alpha", name: "Alpha lab" }, { host: otherHost, folder: "/srv/still", name: "Still mobile" }, { host, folder: "/srv/empty", name: "Empty project" }]
if (projectFixture && rows.length) {
  for (const row of rows.slice(1)) { row.cwd = "/srv/alpha"; row.meta.folder = row.cwd }
  rows[2].meta.pinned = true
  const release = structuredClone(rows[2])
  Object.assign(release, { conversationId: "release", executionId: "release", localSessionId: otherServer.id, hostKey: otherHost, cwd: "/srv/still" })
  Object.assign(release.meta, { id: "release", title: "Review release checklist", hostKey: otherHost, folder: release.cwd, pinned: false, activityAt: now - 180000 })
  rows.push(release)
  const archived = structuredClone(release)
  Object.assign(archived, { conversationId: "archived", executionId: "archived" })
  Object.assign(archived.meta, { id: "archived", title: "Archived task", archivedAt: now })
  rows.push(archived)
}
const preferenceKey = "mobile-thread-library-v1", fixtureStorageKey = "still.mobile.projects-fixture.preferences"
const fixturePreferences = projectFixture ? JSON.parse(localStorage.getItem(fixtureStorageKey) || "null") : null
const saved: AgentLibrary = { rows, workspaces: { ...(fixturePreferences ? { [preferenceKey]: fixturePreferences } : {}), library: { ...readLibraryPreferences(), projects: projectFixture ? projects : [{ host, folder: "/srv/still" }], servers: projectFixture ? [server, otherServer] : [server] } }, storagePath: "fixture://mobile-history", warnings: [] }
const snapshots = new Map(rows.map(row => [row.executionId, row as AgentThreadSnapshot]))
const continuityFixture = new URLSearchParams(location.search).has("continuity")
const agentSinks = new Map<string, (event: AgentThreadEvent) => void>()
const syncCalls: string[] = []
const emitAgent = (id: string, event: Omit<AgentThreadEvent, "sequence">) => {
  const row = snapshots.get(id)!
  const next = { ...event, sequence: ++row.lastSequence, attemptId: id, turnActive: row.turnActive }
  row.transcript.push(next)
  agentSinks.get(id)?.(next)
}
const sharedRow = () => ({
  conversationId: "desktop-shared-task", executionId: "desktop-shared-execution", localSessionId: server.id, hostKey: host,
  agentId: "opencode", agentName: "OpenCode", agentSessionId: "same-remote-provider-session", cwd: "/srv/shared",
  state: "inputRequired", lastSequence: 2, turnActive: true, persistent: true, continuity: true, remoteImported: true,
  configOptions: configForAgent("opencode"),
  pendingPermission: { requestId: "shared-approval", sessionId: "same-remote-provider-session", toolCallId: "tests", title: "Run the shared test suite", options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] },
  meta: { id: "desktop-shared-task", hostKey: host, folder: "/srv/shared", title: "Task started on desktop", pinned: false, createdAt: now, activityAt: now, order: now, draft: "" },
  transcript: [
    { type: "userMessage", sequence: 1, attemptId: "desktop-shared-execution", messageId: "desktop-prompt", text: "Verify the shared remote project." },
    { type: "permission", sequence: 2, attemptId: "desktop-shared-execution", permission: { requestId: "shared-approval", sessionId: "same-remote-provider-session", toolCallId: "tests", title: "Run the shared test suite", options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } },
  ],
} as (typeof rows)[number])
Object.assign(window, { mobileContinuityFixture: { syncCalls } })
registerNativeBridge({ ...mockBridge,
  agentLibrary: async () => saved,
  agentMigrate: async () => [],
  agentFlush: async () => {},
  agentSaveWorkspace: async (key, value) => {
    saved.workspaces[key] = value
    if (projectFixture && key === preferenceKey) localStorage.setItem(fixtureStorageKey, JSON.stringify(value))
  },
  agentSaveMetadata: async () => {},
  agentSnapshot: async id => structuredClone(snapshots.get(id)!),
  subscribeToAgent: async (id, callback) => { agentSinks.set(id, callback); return () => { agentSinks.delete(id) } },
  ...(continuityFixture ? {
    // An explicit test-only transport: this does not claim a real SSH connection.
    hasCredential: async () => true,
    connect: async () => ({ sessionId: "simulated-shared-ssh", status: "connected" as const }),
    status: async () => ({ status: "connected" as const, lastError: null }),
    agentCheck: async () => [],
    agentRemoteLibrary: async () => {
      if (new URLSearchParams(location.search).has("syncFailure")) throw new Error("Remote account identity changed; the saved library was kept.")
      syncCalls.push("library")
      if (!snapshots.has("desktop-shared-execution")) {
        const row = sharedRow()
        saved.rows.push(row)
        snapshots.set(row.executionId, row)
      }
      const partial = new URLSearchParams(location.search).has("legacyWarnings")
      const restoredTitle = new URLSearchParams(location.search).has("restoreTitle")
      const shared = restoredTitle ? { serverAccountId: "00000000-0000-4000-8000-000000000001", conversationId: "desktop-shared-task", executionId: "desktop-shared-execution",
        generation: 1, revision: 2, catalogRevision: 2, fields: { title: 1, pinned: 0, archivedAt: 0, order: 0 },
        values: { title: "Restore the original desktop title", titleSource: "agent" as const, pinned: false, archivedAt: null, order: now },
        readThroughSeq: 0, conversationSeq: 2, projectId: "fixture-project" } : undefined
      if (restoredTitle) (snapshots.get("desktop-shared-execution") as AgentThreadSnapshot & { meta: { title: string } }).meta.title = ""
      return { protocolVersion: 4, serverAccountId: "00000000-0000-4000-8000-000000000001", rows: [{ conversationId: "desktop-shared-task", executionId: "desktop-shared-execution", cwd: "/srv/shared", protocolVersion: 4, shared }],
        warnings: new URLSearchParams(location.search).has("unsafeRecord") ? ["Execution unsafe-record: unsafe record permissions; original records were kept"] : [],
        legacyRecords: partial ? Array.from({ length: new URLSearchParams(location.search).has("manyLegacy") ? 77 : 1 }, (_, index) => ({ executionId: `old-worker-${index + 1}`, reason: "Legacy worker has incomplete conversation/project/provider metadata; its original records were kept" })) : [], next: null }
    },
    agentAttach: async (_native: string, id: string) => { syncCalls.push(`attach:${id}`); return structuredClone(snapshots.get(id)!) },
    agentRespondPermission: async (id: string, requestId: string | number, optionId: string) => {
      const row = snapshots.get(id)!
      syncCalls.push(`answer:${id}:${requestId}`)
      if (row.pendingPermission?.requestId !== requestId) throw new Error("Already answered")
      row.pendingPermission = undefined
      row.state = "complete"; row.turnActive = false
      emitAgent(id, { type: "requestOutcome", requestOutcome: { requestId, kind: "permission", title: "Run the shared test suite", outcome: optionId === "yes" ? "approved" : "rejected" } })
      emitAgent(id, { type: "assistantChunk", text: "Shared tests finished. The original provider session is intact." })
      emitAgent(id, { type: "threadComplete", state: "complete" })
    },
    agentSend: async (id: string, text: string) => {
      const row = snapshots.get(id)!
      syncCalls.push(`send:${id}`)
      row.turnActive = true; row.state = "working"
      if (new URLSearchParams(location.search).has("rejectSend")) {
        emitAgent(id, { type: "userMessage", messageId: "competing-desktop-prompt", text: "Continue the task from desktop instead" })
        throw { code: "agent_prompt_rejected", message: "The agent is busy with a prompt accepted from another device. Your draft is preserved." }
      }
      emitAgent(id, { type: "userMessage", messageId: "phone-prompt", text })
      emitAgent(id, { type: "assistantChunk", text: "Continued the desktop task from this phone." })
      row.turnActive = false; row.state = "complete"
      emitAgent(id, { type: "threadComplete", state: "complete" })
    },
  } : {}),
})

function MobileMockPreview() {
  useEffect(() => {
    const requestedThread = new URLSearchParams(location.search).get("chatpill")
    if (!requestedThread) return
    let opened = false
    const root = document.body
    const sync = () => {
      if (!opened) {
        const thread = [...document.querySelectorAll<HTMLButtonElement>(".mobile-thread-row")]
          .find(button => button.textContent?.includes(requestedThread))
        if (thread) { opened = true; thread.click() }
      }
      if (opened) {
        const auth = document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Authenticate "]')
        const cancel = [...(auth?.querySelectorAll<HTMLButtonElement>("button") || [])]
          .find(button => button.textContent?.trim() === "Cancel")
        cancel?.click()

        // This preview is deliberately offline. Make the saved conversation's
        // composer demonstrable without connecting it to an agent or SSH host.
        const composer = document.querySelector<HTMLFormElement>(".agent-composer")
        const textarea = composer?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message agent"]')
        const send = composer?.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        if (composer && textarea && send && !composer.dataset.fixtureSimulation) {
          composer.dataset.fixtureSimulation = "true"
          const syncSend = () => queueMicrotask(() => {
            if (send.isConnected) send.disabled = !textarea.value.trim()
          })
          textarea.addEventListener("input", syncSend, true)
          composer.addEventListener("submit", event => {
            event.preventDefault()
            event.stopImmediatePropagation()
            const text = textarea.value.trim()
            if (!text) return
            const list = document.querySelector<HTMLElement>(".agent-message-list")
            if (!list) return
            const user = document.createElement("article")
            user.className = "agent-fixture-message agent-fixture-message--user"
            user.setAttribute("aria-label", "Your simulated message")
            user.textContent = text
            Object.assign(user.style, { margin: "16px 0", padding: "12px 14px", borderRadius: "14px", background: "var(--surface-raised, #f2f0ec)", whiteSpace: "pre-wrap" })
            const response = document.createElement("article")
            response.className = "agent-fixture-message agent-fixture-message--response"
            response.setAttribute("aria-label", "Simulated response")
            response.innerHTML = '<strong>Preview simulation · offline</strong><p>This is a mock response. No SSH connection or agent was used.</p>'
            Object.assign(response.style, { margin: "16px 0", padding: "12px 14px", border: "1px solid currentColor", borderRadius: "14px", opacity: ".82" })
            list.append(user, response)
            const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
            valueSetter?.call(textarea, "")
            textarea.dispatchEvent(new Event("input", { bubbles: true }))
            send.disabled = true
          }, true)
        }
      }
    }
    const observer = new MutationObserver(sync)
    observer.observe(root, { childList: true, subtree: true })
    sync()
    return () => observer.disconnect()
  }, [])
  return <MobileApp />
}

createRoot(document.getElementById("root")!).render(<MobileMockPreview />)
