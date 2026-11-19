import { useCallback, useEffect, useState } from "react"
import type { Session } from "../types"
import type { AskSessionAuth } from "../session/connectRequest"
import { nativeBridge } from "../bridge/nativeBridge"
import { reattachAgentThread, startRemoteAgent, syncRemoteAgentLibrary, watchRemoteAgentLibrary, type AgentLibrarySyncStatus, type AgentThreadRow } from "../session/agentThreads"
import AgentLibrarySyncNotice from "./AgentLibrarySyncNotice"
import AgentWorkspace from "./AgentWorkspace"
import { AgentConnectionNotice, useAgentConnection } from "./AgentConnection"
import type { AgentProject } from "../agents/workspace"

export default function RemoteAgentWorkspace({ closing, session, sessions, onNeedAuth, keyTextFor, onClose, onOpenTerminal, presentation, initialConversationId, initialView, initialProject, initialProjectPicker }: {
  presentation?: "desktop" | "mobile"
  initialConversationId?: string
  initialView?: "draft" | "settings"
  initialProject?: AgentProject
  initialProjectPicker?: boolean
  closing: boolean
  session: Session | null
  sessions: Session[]
  onNeedAuth: AskSessionAuth
  keyTextFor: (id: string) => string | null
  onClose: () => void
  onOpenTerminal: (session: Session) => void
}) {
  const [target, setTarget] = useState<Session | null>(session)
  const connection = useAgentConnection(target, onNeedAuth, keyTextFor)
  const [syncStatus, setSyncStatus] = useState<AgentLibrarySyncStatus | null>(null)
  useEffect(() => {
    if (connection.state !== "connected" || !connection.nativeId || nativeBridge.isDevelopmentAdapter) return
    return watchRemoteAgentLibrary(connection.nativeId, setSyncStatus)
  }, [connection.state, connection.nativeId])
  const reattach = useCallback((row: AgentThreadRow) => reattachAgentThread(row.executionId,connection.nativeId || ""),[connection.nativeId])
  return <AgentWorkspace presentation={presentation} initialConversationId={initialConversationId} initialView={initialView} initialProject={initialProject} initialProjectPicker={initialProjectPicker} closing={closing} session={target} sessions={sessions} onSelectHost={setTarget}
    onReattach={reattach} transportId={connection.nativeId || undefined}
    connected={connection.state === "connected"} connectionNotice={target && <AgentConnectionNotice connection={connection} />}
    syncNotice={<AgentLibrarySyncNotice status={syncStatus} compact />}
    onClose={onClose} onOpenTerminal={target ? () => onOpenTerminal(target) : undefined}
    onStart={(agentId, options, onCreated) => startRemoteAgent(connection.nativeId || "", target?.id || "", agentId, options, target || undefined, onCreated)}
    onCheck={(agentId, executable, customAgent, testConnection) => nativeBridge.agentCheck(connection.nativeId || "", agentId, executable, customAgent, testConnection)}
    onCatalog={(agentId, cwd, executable) => nativeBridge.agentCatalog(connection.nativeId || "", agentId, cwd, executable)}
    onResolveFolder={async cwd => {
      const folder = await nativeBridge.agentResolveFolder(connection.nativeId || "", cwd)
      if (!nativeBridge.isDevelopmentAdapter) await syncRemoteAgentLibrary(connection.nativeId || "")
      return folder
    }} />
}
