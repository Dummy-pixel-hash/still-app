import { useCallback, useEffect, useRef, useState } from "react"
import {
  nativeBridge,
  type OrbRow,
  type AgentStatus,
} from "../bridge/nativeBridge"

const WIN = 96
const ORB = 64
const POS_KEY = "still.orb.pos.v2"

const URGENCY: Record<AgentStatus, number> = {
  "needs-input": 0,
  error: 1,
  working: 2,
  done: 3,
  idle: 4,
  unknown: 5,
}

/** Face color per state: working = violet-blue glow (the "Generating" ball),
 *  needs-input = warm amber (the only one that needs YOU), done = calm
 *  green, error = red, idle/unknown = dim hollow. */
export function orbFace(status: AgentStatus, hasSessions: boolean): string {
  if (!hasSessions) return "orb-face-idle"
  switch (status) {
    case "needs-input":
      return "orb-face-question"
    case "working":
      return "orb-face-working"
    case "error":
      return "orb-face-error"
    case "done":
      return "orb-face-done"
    default:
      return "orb-face-idle"
  }
}

export function orbPulse(status: AgentStatus): string {
  if (status === "needs-input") return "orb-pulse-fast"
  if (status === "working") return "orb-pulse-slow"
  return ""
}

function aggregate(rows: OrbRow[]): AgentStatus {
  let worst: AgentStatus = "idle"
  let first = true
  for (const r of rows) {
    if (first || URGENCY[r.status] < URGENCY[worst]) worst = r.status
    first = false
  }
  return rows.length === 0 ? "idle" : worst
}

const DOT: Record<AgentStatus, string> = {
  "needs-input": "#f5b942",
  working: "#8b7cf6",
  error: "#ff5a5a",
  done: "#4ade80",
  idle: "rgba(255,255,255,0.28)",
  unknown: "rgba(255,255,255,0.20)",
}

/** Segmented rim: one arc per live session (max 8), worst-first. A single
 *  session is a solid ring; a mix reads as a gradient like the reference. */
function rimBackground(rows: OrbRow[]): string | undefined {
  if (rows.length <= 1) return undefined
  const sorted = [...rows]
    .sort((a, b) => URGENCY[a.status] - URGENCY[b.status])
    .slice(0, 8)
  const n = sorted.length
  const segs = sorted.map((r, i) => {
    const a0 = (i / n) * 360
    const a1 = ((i + 1) / n) * 360
    return `${DOT[r.status]} ${a0}deg ${a1}deg`
  })
  return `conic-gradient(${segs.join(", ")})`
}

function savePos(x: number, y: number) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x, y }))
  } catch {
    /* private mode — in-memory is fine */
  }
}
function loadPos(): { x: number; y: number } | null {
  try {
    const raw =
      localStorage.getItem(POS_KEY) ?? localStorage.getItem("still.orb.pos.v1")
    return raw ? (JSON.parse(raw) as { x: number; y: number }) : null
  } catch {
    return null
  }
}

/**
 * Orb companion (tiny `orb` webview at `?orb=1`). Fixed 96px window that
 * NEVER resizes — the old hover-expand resized the OS window and fought
 * DPI scaling. The face shows the worst live state; the rim shows the mix
 * (one arc per session). Click restores the neediest session's workspace.
 * Renders ONLY renderer-pushed snapshot rows — never SSH bytes.
 */
export default function OrbScreen() {
  const [rows, setRows] = useState<OrbRow[]>([])
  const [menu, setMenu] = useState(false)
  const posRef = useRef<{ x: number; y: number }>(loadPos() ?? { x: 0, y: 0 })
  const dragPending = useRef(false)
  const dragTimer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const snap = await nativeBridge.orbSnapshot()
        if (alive) setRows(snap.rows.slice(0, 8))
      } catch {
        /* no native runtime: keep last known rows */
      }
    }
    void refresh()
    const t = window.setInterval(refresh, 2000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  const restore = useCallback(() => {
    void nativeBridge.restoreFromOrb()
  }, [])
  const quit = useCallback(() => {
    void nativeBridge.quit()
  }, [])

  // Restore saved position on boot (after Rust's bottom-right default).
  // Fixed window: size never changes, only position.
  useEffect(() => {
    const saved = loadPos()
    if (saved && (saved.x !== 0 || saved.y !== 0)) {
      posRef.current = saved
      void nativeBridge.orbSetSize(WIN, WIN).catch(() => {})
      void nativeBridge.orbSetPosition(saved.x, saved.y).catch(() => {})
    }
  }, [])

  const beginDrag = useCallback(() => {
    void nativeBridge.orbStartDrag().catch(() => {}).finally(() => {
      // Persist wherever the OS dropped us.
      void nativeBridge
        .orbGetPosition()
        .then((p) => {
          posRef.current = p
          savePos(p.x, p.y)
        })
        .catch(() => {})
    })
  }, [])

  const clearDragTimer = () => {
    if (dragTimer.current !== null) {
      window.clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
    dragPending.current = true
    clearDragTimer()
    dragTimer.current = window.setTimeout(() => {
      if (dragPending.current) {
        dragPending.current = false
        beginDrag()
      }
    }, 140)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (
      dragPending.current &&
      (Math.abs(e.movementX) > 2 || Math.abs(e.movementY) > 2)
    ) {
      dragPending.current = false
      clearDragTimer()
      beginDrag()
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    clearDragTimer()
    const wasClick = dragPending.current
    dragPending.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (wasClick) {
      if (menu) setMenu(false)
      else restore()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        restore()
      } else if (e.key === "Escape") {
        setMenu(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [restore])

  const status = aggregate(rows)
  const rim = rimBackground(rows)
  const face = orbFace(status, rows.length > 0)
  const pulse = orbPulse(status)
  const tip =
    rows.length === 0
      ? "Still — idle"
      : rows
          .slice()
          .sort((a, b) => URGENCY[a.status] - URGENCY[b.status])
          .map((r) => `${r.name}: ${r.status}`)
          .join("\n")

  return (
    <div
      className="grid h-full w-full place-items-center overflow-hidden"
      style={{ background: "transparent", fontFamily: "var(--font-sans)" }}
      title={tip}
    >
      {menu ? (
        <div
          role="menu"
          aria-label="Still orb menu"
          className="flex h-[96px] w-[96px] flex-col items-stretch justify-center gap-1 rounded-2xl border border-white/10 bg-[#0b0b0e]/95 p-1.5"
          style={{ background: "rgba(11,11,14,0.95)" }}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              setMenu(false)
              restore()
            }}
            className="rounded-lg px-2 py-1.5 text-left text-[11px] text-still-fg hover:bg-white/10"
          >
            Restore
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false)
              quit()
            }}
            className="rounded-lg px-2 py-1.5 text-left text-[11px] text-[#ff6b6b] hover:bg-white/10"
          >
            Quit
          </button>
        </div>
      ) : (
        <button
          type="button"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu(true)
          }}
          aria-label={`Still — ${rows.length} live session${rows.length === 1 ? "" : "s"} — ${status}`}
          title={tip}
          className="orb-hit relative grid select-none place-items-center rounded-full p-0"
          style={{ width: WIN, height: WIN, background: "transparent" }}
        >
          {/* segmented rim: solid color for one session, conic arcs for many */}
          <span
            aria-hidden
            className="absolute rounded-full"
            style={
              rim
                ? {
                    width: ORB + 6,
                    height: ORB + 6,
                    background: rim,
                    opacity: 0.9,
                    filter: "saturate(1.1)",
                  }
                : {
                    width: ORB + 6,
                    height: ORB + 6,
                    background: "transparent",
                    border: `2px solid ${DOT[status]}`,
                    opacity: rows.length === 0 ? 0.35 : 0.9,
                  }
            }
          />
          {/* glossy face */}
          <span
            aria-hidden
            className={`relative rounded-full ${face} ${pulse}`}
            style={{ width: ORB, height: ORB }}
          >
            {/* specular highlight */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 32% 26%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.12) 22%, transparent 42%), radial-gradient(circle at 50% 115%, rgba(0,0,0,0.55) 0%, transparent 55%)",
              }}
            />
            {/* status eyes: two pills when live, none when idle */}
            {rows.length > 0 && status !== "idle" && status !== "unknown" ? (
              <span
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 gap-[7px]"
              >
                <span className="orb-eye" />
                <span className="orb-eye" />
              </span>
            ) : null}
          </span>
          {/* live count */}
          {rows.length > 1 && (
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-[6px] right-[6px] grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 font-mono text-[10px] font-bold leading-none"
              style={{ background: DOT[status], color: "#08080a" }}
            >
              {rows.length}
            </span>
          )}
        </button>
      )}

      <style>{`
        .orb-hit { outline: none; cursor: pointer; -webkit-app-region: no-drag; }
        .orb-hit:focus-visible { filter: brightness(1.25); }
        .orb-face-working { background: radial-gradient(circle at 50% 42%, #3b2f7a 0%, #241d4e 46%, #12101f 78%, #0a0a12 100%); box-shadow: 0 0 18px 2px rgba(139,124,246,0.45), inset 0 0 12px rgba(139,124,246,0.35); }
        .orb-face-question { background: radial-gradient(circle at 50% 42%, #7a5a24 0%, #4e3a17 46%, #221a0e 78%, #100c06 100%); box-shadow: 0 0 20px 3px rgba(245,185,66,0.55), inset 0 0 12px rgba(245,185,66,0.4); }
        .orb-face-done { background: radial-gradient(circle at 50% 42%, #1e4d33 0%, #143324 46%, #0c1f16 78%, #060f0b 100%); box-shadow: 0 0 14px 2px rgba(74,222,128,0.4), inset 0 0 12px rgba(74,222,128,0.3); }
        .orb-face-error { background: radial-gradient(circle at 50% 42%, #6e1f1f 0%, #471414 46%, #200b0b 78%, #100606 100%); box-shadow: 0 0 18px 2px rgba(255,90,90,0.5), inset 0 0 12px rgba(255,90,90,0.35); }
        .orb-face-idle { background: radial-gradient(circle at 50% 42%, #26262b 0%, #17171b 52%, #0e0e11 80%, #08080a 100%); box-shadow: 0 0 0 1px rgba(255,255,255,0.07), inset 0 0 10px rgba(255,255,255,0.05); }
        .orb-eye { width: 5px; height: 11px; border-radius: 999px; background: rgba(255,255,255,0.92); box-shadow: 0 0 6px rgba(255,255,255,0.6); }
        @keyframes orb-breathe-slow { 0%,100% { transform: scale(1); filter: brightness(1); } 50% { transform: scale(1.045); filter: brightness(1.18); } }
        @keyframes orb-breathe-fast { 0%,100% { transform: scale(1); filter: brightness(1); } 50% { transform: scale(1.08); filter: brightness(1.35); } }
        .orb-pulse-slow { animation: orb-breathe-slow 2.6s ease-in-out infinite; }
        .orb-pulse-fast { animation: orb-breathe-fast 1.1s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .orb-pulse-slow, .orb-pulse-fast { animation: none; } }
      `}</style>
    </div>
  )
}
