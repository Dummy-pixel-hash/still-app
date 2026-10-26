import type { Session } from "../types"
import type { AskSessionAuth } from "../session/connectRequest"
import { nativeBridge } from "../bridge/nativeBridge"
import { startRemoteAgent } from "../session/agentThreads"
import { hostKey } from "../agents/workspace"
import AgentWorkspace from "./AgentWorkspace"
import { AgentConnectionNotice, useAgentConnection } from "./AgentConnection"

export default function RemoteAgentWorkspace({ session, sessions, onNeedAuth, keyTextFor, onClose, onOpenTerminal }: {
  session: Session
  sessions: Session[]
  onNeedAuth: AskSessionAuth
  keyTextFor: (id: string) => string | null
  onClose: () => void
  onOpenTerminal: () => void
}) {
  const connection = useAgentConnection(session, onNeedAuth, keyTextFor)
  return <AgentWorkspace session={session} relatedSessionIds={sessions.filter(candidate => hostKey(candidate) === hostKey(session)).map(candidate => candidate.id)}
    connected={connection.state === "connected"} connectionNotice={<AgentConnectionNotice connection={connection} />}
    onClose={onClose} onOpenTerminal={onOpenTerminal}
    onStart={(agentId, options, onCreated) => startRemoteAgent(connection.nativeId || "", session.id, agentId, options, session, onCreated)}
    onCheck={(agentId, executable) => nativeBridge.agentCheck(connection.nativeId || "", agentId, executable)} />
}
