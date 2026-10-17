import type { OrbPreferences, OrbRow, OrbSessionInput, OrbSnapshot, OrbVisualState } from "./types"

export const DEFAULT_ORB_PREFERENCES: Readonly<OrbPreferences> = Object.freeze({ enabled: false, size: 64, paused: false })
export const OUTPUT_ACTIVE_MS = 3000
export const PUBLISH_HEARTBEAT_MS = 4000
export const PUBLISH_STALE_MS = 15000
export const MAX_ORB_ROWS = 64

export function normalizeOrbPreferences(value: unknown): OrbPreferences {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {}
  return {
    enabled: v.enabled === true,
    size: v.size === 48 || v.size === 96 ? v.size : 64,
    paused: v.paused === true,
  }
}

export function emptyOrbSnapshot(): OrbSnapshot {
  return { revision: 0, publishedAt: 0, preferences: { ...DEFAULT_ORB_PREFERENCES }, rows: [] }
}

export function outputIsActive(row: OrbRow, now: number): boolean {
  return row.signal === "connected" && row.lastOutputAt !== null &&
    row.lastOutputAt <= now && now - row.lastOutputAt < OUTPUT_ACTIVE_MS
}

export function describeOrbRow(row: OrbRow, now: number): { visual: OrbVisualState; label: string; detail: string; priority: number } {
  switch (row.signal) {
    case "auth": return { visual: "needs-input", label: "Sign-in required", detail: "A connection is waiting for your credentials in Still.", priority: 0 }
    case "host-key": return { visual: "needs-input", label: "Review host key", detail: "Review this server’s identity in Still before connecting.", priority: 0 }
    case "host-key-changed": return { visual: "error", label: "Host key changed", detail: "The connection was refused. Review the changed identity in Still.", priority: 1 }
    case "error": return { visual: "error", label: "Connection error", detail: "Open Still to inspect the connection error.", priority: 1 }
    case "connecting": return { visual: "unknown", label: "Connecting", detail: "Still is establishing the SSH connection.", priority: 3 }
    case "connected": return outputIsActive(row, now)
      ? { visual: "working", label: "Output active", detail: "Terminal output is arriving. This does not establish the agent’s state.", priority: 2 }
      : { visual: "unknown", label: "Connected · agent status unknown", detail: "No recent output. Silence does not mean an agent is finished or waiting.", priority: 4 }
  }
}

export function sortOrbRows(rows: readonly OrbRow[], now: number): OrbRow[] {
  return [...rows].sort((a, b) => describeOrbRow(a, now).priority - describeOrbRow(b, now).priority ||
    b.changedAt - a.changedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
}

export function orbSummary(snapshot: OrbSnapshot, now: number) {
  const stale = snapshot.publishedAt === 0 || now - snapshot.publishedAt > PUBLISH_STALE_MS || snapshot.publishedAt > now + 1000
  if (stale) return {
    visual: "unknown" as OrbVisualState,
    label: snapshot.publishedAt === 0 ? "Waiting for Still" : "Status unavailable",
    detail: "The workspace has not sent a fresh update. Open Still to check your sessions.",
    row: null,
    rows: [] as OrbRow[],
    stale: true,
  }
  const rows = sortOrbRows(snapshot.rows, now)
  const row = rows[0] ?? null
  return {
    ...(row ? describeOrbRow(row, now) : { visual: "idle" as OrbVisualState, label: "No active connections", detail: "Open Still to connect a session." }),
    row, rows, stale: false,
  }
}

export function buildOrbRows(inputs: readonly OrbSessionInput[], activity: ReadonlyMap<string, number>, now: number): OrbRow[] {
  const rows: OrbRow[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    if (seen.has(input.id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) continue
    seen.add(input.id)
    if (input.connection === "disconnected" && !input.attention) continue
    const last = activity.get(input.id)
    rows.push({
      sessionId: input.id,
      name: Array.from(input.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()).slice(0, 100).join("") || "Untitled session",
      signal: input.attention ?? (input.connection === "disconnected" ? "connecting" : input.connection),
      changedAt: Number.isFinite(input.changedAt) ? Math.max(0, Math.min(now, Math.floor(input.changedAt))) : now,
      lastOutputAt: input.connection === "connected" && last !== undefined && now - last < OUTPUT_ACTIVE_MS && last <= now ? last : null,
    })
  }
  return sortOrbRows(rows, now).slice(0, MAX_ORB_ROWS)
}

export function orbWindowSide(size: number): number { return Math.ceil(size * 1.4) + 8 }

/** Preview geometry; native placement independently clamps physical work areas. */
export function clampOrbPosition(x: number, y: number, width: number, height: number, size: number) {
  const margin = size * 0.2 + 8
  return {
    x: Math.max(margin, Math.min(Math.max(margin, width - size - margin), Number.isFinite(x) ? x : margin)),
    y: Math.max(margin, Math.min(Math.max(margin, height - size - margin), Number.isFinite(y) ? y : margin)),
  }
}
