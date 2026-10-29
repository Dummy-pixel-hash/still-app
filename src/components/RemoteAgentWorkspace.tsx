import { useCallback, useState } from "react"
import type { Session } from "../types"
import type { AskSessionAuth } from "../session/connectRequest"
import { nativeBridge } from "../bridge/nativeBridge"
import { reattachAgentThread, startRemoteAgent, type AgentThreadRow } from "../session/agentThreads"
import AgentWorkspace from "./AgentWorkspace"
import { AgentConnectionNotice, useAgentConnection } from "./AgentConnection"

export default function RemoteAgentWorkspace({ session, sessions, onNeedAuth, keyTextFor, onClose, onOpenTerminal }: {
  session: Session | null
  sessions: Session[]
  onNeedAuth: AskSessionAuth
  keyTextFor: (id: string) => string | null
  onClose: () => void
  onOpenTerminal: (session: Session) => void
}) {
  const [target, setTarget] = useState<Session | null>(session)
  const connection = useAgentConnection(target, onNeedAuth, keyTextFor)
  const reattach = useCallback((row: AgentThreadRow) => reattachAgentThread(row.executionId,connection.nativeId || ""),[connection.nativeId])
  return <AgentWorkspace session={target} sessions={sessions} onSelectHost={setTarget}
    onReattach={reattach} transportId={connection.nativeId || undefined}
    connected={connection.state === "connected"} connectionNotice={target && <AgentConnectionNotice connection={connection} />}
    onClose={onClose} onOpenTerminal={target ? () => onOpenTerminal(target) : undefined}
    onStart={(agentId, options, onCreated) => startRemoteAgent(connection.nativeId || "", target?.id || "", agentId, options, target || undefined, onCreated)}
    onCheck={(agentId, executable) => nativeBridge.agentCheck(connection.nativeId || "", agentId, executable)}
    onCatalog={(agentId, cwd, executable) => nativeBridge.agentCatalog(connection.nativeId || "", agentId, cwd, executable)}
    onResolveFolder={cwd => nativeBridge.agentResolveFolder(connection.nativeId || "", cwd)} />
}
