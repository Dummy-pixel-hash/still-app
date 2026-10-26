import type { Session } from "../types"
import type { ConnectRequest } from "./connections"

export type AskSessionAuth = (session: Session) => Promise<{ secret?: string; remember: boolean } | null>

/** Authentication/request construction is shared by terminal and agent entry. */
export async function buildConnectRequest(
  session: Session,
  askAuth: AskSessionAuth,
  keyTextFor: (id: string) => string | null,
  options: { localId?: string; sshOnly?: boolean; cols?: number; rows?: number } = {},
): Promise<ConnectRequest | null> {
  const key = session.authMethod === "key" && session.keyId ? keyTextFor(session.keyId) : null
  const answer = key ? { secret: key, remember: false } : await askAuth(session)
  if (!answer) return null
  return {
    localId: options.localId || session.id,
    host: session.host, port: session.port, username: session.username,
    authKind: session.authMethod === "key" ? "privateKey" : "password",
    secret: answer.secret, remember: answer.remember,
    tmuxSession: session.tmuxSession,
    workingDirectory: options.sshOnly ? undefined : session.workingDirectory,
    sshOnly: options.sshOnly,
    cols: options.cols || 80, rows: options.rows || 24,
  }
}
