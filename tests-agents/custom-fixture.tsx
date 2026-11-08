import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import "../src/styles/theme.css"
import AgentWorkspace from "../src/components/AgentWorkspace"
import { AGENTS, type AgentLaunchOptions, type AgentThreadSnapshot } from "../src/agents/types"
import { hostKey } from "../src/agents/workspace"
import { nativeBridge, registerNativeBridge } from "../src/bridge/nativeBridge"
import { mockBridge } from "../src/bridge/mockBridge"
import { startRemoteAgent } from "../src/session/agentThreads"
import type { Session } from "../src/types"

const servers: Session[] = ["alpha", "beta"].map((name, index) => ({ id: name, name, projectId: "test", host: `${name}.example`, port: 22, username: "dev", authMethod: "ask", remember: false, workingDirectory: "/srv/project", tmuxSession: "unused", createdAt: index, updatedAt: 0 }))
const projects = servers.map(server => ({ host: hostKey(server), folder: "/srv/project" }))
const storage = "still.custom-agent-fixture"
const state = { tests: 0, checks: [] as string[], launches: [] as { id: string; options?: AgentLaunchOptions }[], rows: {} as Record<string, AgentThreadSnapshot> }
Object.assign(window, { customFixture: state })
registerNativeBridge({ ...mockBridge,
  agentLibrary: async () => ({ rows: [], workspaces: { library: JSON.parse(localStorage.getItem(storage) || JSON.stringify({ projects, servers })) }, storagePath: "fixture", warnings: [], liveExecutions: [] }),
  agentSaveWorkspace: async (_key, value) => { localStorage.setItem(storage, JSON.stringify(value)) },
  agentSaveMetadata: async () => {}, agentDeleteSaved: async () => {}, agentFlush: async () => {}, agentMigrate: async () => [],
  agentCheck: async (_native, id, _executable, custom, testing) => {
    if (testing) { state.tests++; await new Promise(resolve => setTimeout(resolve, 180)) }
    state.checks.push(id || "all")
    return (id ? [{ id, executable: custom?.executable || id }] : AGENTS).map(agent => ({ agentId: agent.id, installed: true, available: custom?.executable !== "bad-cli", runtime: "acp" as const, runtimeAvailable: true, executable: custom?.executable || `/usr/bin/${agent.executable}`, checkedAt: Date.now(), message: custom?.executable === "bad-cli" ? "The executable did not speak ACP over stdio. Check the protocol arguments." : undefined }))
  },
  agentStart: async (_native, local, id, options) => {
    state.launches.push({ id, options })
    const snapshot: AgentThreadSnapshot = { conversationId: options?.conversationId, executionId: `custom-fixture-${state.launches.length}`, localSessionId: local, agentId: id, agentName: options?.customAgent?.name || id, customAgent: options?.customAgent, cwd: options?.cwd || "/srv/project", state: "complete", transcript: [], lastSequence: 0, turnActive: false, configOptions: [], commands: [], resumable: false, historyCapabilities: { revert: false, retry: false } }
    state.rows[snapshot.executionId] = snapshot
    return snapshot
  },
  agentSnapshot: async id => state.rows[id],
  subscribeToAgent: async () => () => {}, agentClose: async () => {},
})
function Fixture() {
  const [server, setServer] = useState(servers[0])
  return <AgentWorkspace session={server} sessions={servers} transportId={`native-${server.id}`} connected onClose={() => {}} onSelectHost={selected => setServer(selected)} onCheck={(id, executable, custom, testing) => nativeBridge.agentCheck(`native-${server.id}`, id, executable, custom, testing)} onStart={(id, options, created) => startRemoteAgent(`native-${server.id}`, server.id, id, options, server, created)} />
}
createRoot(document.getElementById("root")!).render(<Fixture />)
