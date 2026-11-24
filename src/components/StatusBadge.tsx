import type { ConnState } from "../types"

export type CardConn = ConnState | "never"

/**
 * Connection state as shape + text, never colour alone. Connected is a
 * filled circle, connecting a half ring, error a triangle, detached a hollow
 * ring and idle a dash. The shapes use currentColor, so they survive
 * forced-colours mode.
 */
const META: Record<CardConn, { label: string; tone: string; pulse: boolean }> = {
  connected: { label: "Connected", tone: "text-[#ff6b6b]", pulse: true },
  connecting: { label: "Connecting", tone: "text-[#d6d1cd]", pulse: true },
  error: { label: "Error", tone: "text-[#ff8a8a]", pulse: false },
  disconnected: { label: "Detached", tone: "text-[#a9a3ad]", pulse: false },
  never: { label: "Idle", tone: "text-[#a9a4a0]", pulse: false },
}

function Shape({ conn }: { conn: CardConn }) {
  const common = { width: 10, height: 10, viewBox: "0 0 10 10", "aria-hidden": true as const, className: "shrink-0" }
  switch (conn) {
    case "connected":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="4" fill="currentColor" />
        </svg>
      )
    case "connecting":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.4" />
          <path d="M5 1.4 A3.6 3.6 0 0 1 5 8.6 Z" fill="currentColor" />
        </svg>
      )
    case "error":
      return (
        <svg {...common}>
          <path d="M5 1 L9.2 8.6 H0.8 Z" fill="currentColor" />
        </svg>
      )
    case "disconnected":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <rect x="1" y="4.2" width="8" height="1.6" rx="0.8" fill="currentColor" />
        </svg>
      )
  }
}

export default function StatusBadge({
  conn,
  descriptionId,
}: {
  conn: CardConn
  /** id of a hidden element carrying the error text, for the Error state. */
  descriptionId?: string
}) {
  const meta = META[conn]
  return (
    <span
      data-status={conn}
      aria-describedby={descriptionId}
      className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${meta.tone}`}
    >
      <span className={meta.pulse ? "animate-[breathe_2.4s_ease-in-out_infinite]" : ""}>
        <Shape conn={conn} />
      </span>
      <span className="text-dim">{meta.label}</span>
    </span>
  )
}
