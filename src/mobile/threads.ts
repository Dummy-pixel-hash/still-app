import { conversation } from "../agents/transcript"
import type { AgentThreadRow } from "../session/agentThreads"

export function needsAttention(row: AgentThreadRow): boolean {
  if (row.pendingInput || row.pendingPermission) return true
  return conversation(row.transcript).some(item => item.kind === "request" && !item.requestOutcome)
}
export function visibleThreads(rows: AgentThreadRow[]) {
  return rows.filter(row => !row.meta.archivedAt && (!row.meta.prepared || row.state === "saved" || !!row.meta.draft || row.transcript.some(event => event.type === "userMessage")))
    .sort((a, b) => b.meta.activityAt - a.meta.activityAt)
}
export function mobileThreadStatus(row: AgentThreadRow) {
  if (row.state === "submissionUnknown" || row.meta.submissionUnknown) return "Check status"
  if (needsAttention(row)) return "Needs you"
  if (row.state === "error") return "Connection issue"
  if (row.turnActive) return "Working"
  if (row.state === "connecting") return "Connecting"
  if (row.state === "saved" || row.state === "detached") return "Saved"
  if (row.state === "complete") return "Complete"
  return "Ready"
}
export function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}
