// Still orb — snapshot builder (main renderer side).
//
// The main window stays alive while hidden, so it builds and pushes fresh
// snapshot rows to Rust (`still_orb_push`), which fans them out to the orb.
// The orb never touches SSH or reads transcripts itself; it only renders
// these rows. Metadata only — no secrets, no raw escape passthrough.

import type { AgentStatus, OrbRow, OrbSnapshot } from "../bridge/nativeBridge"
import type { Session } from "../types"
import { connectionState } from "./connections"
import { frozenPreview, snapshotPreviewLines } from "./connections"
import { detectStatus, pickSnippet, redactLine } from "./agentStatus"

const URGENCY: Record<AgentStatus, number> = {
  "needs-input": 0,
  error: 1,
  working: 2,
  done: 3,
  idle: 4,
  unknown: 5,
}

export function sortOrbRows(rows: OrbRow[]): OrbRow[] {
  return [...rows].sort((a, b) => {
    const u = URGENCY[a.status] - URGENCY[b.status]
    if (u !== 0) return u
    return b.changedAt - a.changedAt
  })
}

/**
 * Build the orb stack from live sessions. Phase 1 program ID is always
 * "unknown" — program detection lands with native pane command/title fetch.
 * Snippets come from the existing preview pipeline (never raw escapes).
 */
export function buildOrbSnapshot(sessions: Session[]): OrbSnapshot {
  const rows: OrbRow[] = []
  for (const s of sessions) {
    const state = connectionState(s.id)
    const live = state === "connected" || state === "connecting" || state === "error"
    if (!live) continue

    const frozen = frozenPreview(s.id)
    const lines = frozen && frozen.length ? frozen : snapshotPreviewLines(s.id, 14)
    const snippet = redactLine(pickSnippet(lines)) || "no output — idle"
    const status = detectStatus(lines, state)

    rows.push({
      sessionId: s.id,
      name: s.name,
      host: s.host,
      program: "unknown",
      status,
      snippet,
      changedAt: s.updatedAt ?? Date.now(),
      tmuxSession: s.tmuxSession,
    })
  }
  return { rows: sortOrbRows(rows) }
}

/** Cheap fingerprint so the 2.5s push loop only ships real changes. */
export function orbFingerprint(snapshot: OrbSnapshot): string {
  return snapshot.rows
    .map((r) => `${r.sessionId}:${r.status}:${r.snippet}`)
    .join("|")
}
