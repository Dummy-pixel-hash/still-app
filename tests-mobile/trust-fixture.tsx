import React from "react"
import { createRoot } from "react-dom/client"
import "../src/styles/theme.css"
import "../src/mobile/mobile.css"
import AgentWorkspace from "../src/components/AgentWorkspace"
import { AgentConnectionNotice } from "../src/components/AgentConnection"
import { registerNativeBridge } from "../src/bridge/nativeBridge"
import { mockBridge } from "../src/bridge/mockBridge"
import type { Session } from "../src/types"
import { hostKey, readLibraryPreferences } from "../src/agents/workspace"

const server: Session = { id: "fixture-host-trust", name: "Verification fixture", host: "fixture.invalid", port: 22, username: "fixture", projectId: "", workingDirectory: "", authMethod: "ask", remember: false, tmuxSession: "", createdAt: 1, updatedAt: 1 }
const preferences = { ...readLibraryPreferences(), servers: [server] }
registerNativeBridge({ ...mockBridge,
  agentLibrary: async () => ({ rows: [], workspaces: { library: preferences }, storagePath: "fixture://host-trust", warnings: [] }),
  agentSaveWorkspace: async () => {}, agentMigrate: async () => [],
  trustHost: async () => { throw { code: "keyring", message: "Could not persist host trust: fixture storage is not writable." } },
})
document.documentElement.classList.add("still-mobile")
const connection = {
  localId: "fixture-host-trust", nativeId: null, state: "error" as const, busy: false, error: null,
  connect: async () => {},
  hostPrompt: { host: server.host, port: 22, keyType: "ssh-ed25519", fingerprint: "SHA256:example-fixture-not-a-real-server-key", opensshKey: "ssh-ed25519 AAAAfixture", changed: false },
}
createRoot(document.getElementById("root")!).render(<div className="mobile-app"><AgentWorkspace presentation="mobile" session={server} sessions={[server]} connected={false} initialProjectPicker initialProject={{ host: hostKey(server), folder: "" }} connectionNotice={<AgentConnectionNotice connection={connection} />} onClose={() => {}} /></div>)
