import type { SessionTransport } from "../types"

export function sessionHostKey(session: {
  transport?: SessionTransport
  host: string
  port: number
  username: string
}) {
  return session.transport === "local"
    ? JSON.stringify(["local", "this-device"])
    : JSON.stringify([session.host.toLowerCase(), session.port, session.username])
}
