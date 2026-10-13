import { useCallback, useEffect, useRef, useState } from "react"
import {
  nativeBridge,
  type OrbRow,
  type AgentStatus,
} from "../bridge/nativeBridge"

const WINDOW = 128
const ORB = 96
const CARD_W = 300
const ROW_H = 52
const HEAD_H = 96
const MENU_W = 208
const MENU_H = 248
const POS_KEY = "still.orb.pos.v1"

const URGENCY: Record<AgentStatus, number> = {
  "needs-input": 0,
  working: 1,
  error: 2,
  done: 3,
  idle: 4,
  unknown: 5,
}
const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  "needs-input": "Needs input",
  idle: "Idle",
  done: "Finished",
  error: "Error",
  unknown: "—",
}

function aggregate(rows: OrbRow[]): AgentStatus {
  const worst = rows.reduce<AgentStatus | null>((acc, r) => {
    if (acc === null) return r.status
    return URGENCY[r.status] < URGENCY[acc] ? r.status : acc
  }, null)
  return worst ?? "idle"
}

function ring(status: AgentStatus, hasSessions: boolean): string {
  if (!hasSessions) return "border-white/10"
  switch (status) {
    case "needs-input":
      return "border-[#f5b942] shadow-[0_0_28px_3px_rgba(245,185,66,0.4)]"
    case "working":
      return "border-[#ff4a4a] shadow-[0_0_28px_3px_rgba(255,74,74,0.4)]"
    case "error":
      return "border-[#ff4a4a]/70"
    case "done":
      return "border-[#4ade80]"
    default:
      return "border-white/10"
  }
}

function savePos(x: number, y: number) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x, y }))
  } catch {
    /* private-mode storage — in-memory copy is fine */
  }
}
function loadPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    return raw ? (JSON.parse(raw) as { x: number; y: number }) : null
  } catch {
    return null
  }
}

/**
 * Orb companion (rendered in the tiny `orb` webview at `?orb=1`).
 * A floating status circle: breathe = busy, amber = blocked, green = finished
 * while away. Hover floats the live session stack; click restores the main
 * window. Renders ONLY renderer-pushed snapshot rows — never SSH bytes.
 */
export default function OrbScreen() {
  const [rows, setRows] = useState<OrbRow[]>([])
  const [menu, setMenu] = useState(false)
  const hoverRef = useRef(false)

  const posRef = useRef<{ x: number; y: number }>(loadPos() ?? { x: 0, y: 0 })
  const dragPending = useRef(false)
  const dragTimer = useRef<number | null>(null)
  const leaveTimer = useRef<number | null>(null)

  // ---------- snapshot feed ----------
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const snap = await nativeBridge.orbSnapshot()
        if (alive) setRows(snap.rows)
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

  // ---------- window geometry ----------
  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current)
      leaveTimer.current = null
    }
  }, [])

  const applySizePos = useCallback(
    async (w: number, h: number, x: number, y: number) => {
      await nativeBridge.orbSetSize(w, h)
      await nativeBridge.orbSetPosition(x, y)
    },
    [],
  )

  const expand = useCallback(async () => {
    const n = Math.min(rows.length, 4)
    const h = HEAD_H + n * ROW_H
    // Read the true window position (accounts for native drags since the
    // last hover) and persist it so geometry stays accurate across launches.
    const p = await nativeBridge.orbGetPosition().catch(() => posRef.current)
    posRef.current = p
    savePos(p.x, p.y)
    const mon = await nativeBridge.orbGetMonitorBounds()
    // Keep the circle pinned at its screen spot; card grows upward, flipping
    // below when the orb sits too close to the top edge.
    const cardAbove = p.y + WINDOW - h - ROW_H >= mon.y
    const nx = Math.min(
      Math.max(p.x + WINDOW / 2 - CARD_W / 2, mon.x),
      mon.x + mon.width - CARD_W,
    )
    const ny = cardAbove ? p.y - (h - WINDOW) : p.y
    await applySizePos(CARD_W, h, nx, ny)
    posRef.current = { x: nx, y: ny }
  }, [rows.length, applySizePos])

  const collapse = useCallback(async () => {
    const { x, y } = posRef.current
    await applySizePos(WINDOW, WINDOW, x, y)
  }, [applySizePos])

  // Right-click menu needs a taller window than the 128px circle: grow
  // upward (menu on top, circle pinned at the bottom) so the OS window
  // never clips it. Mirrors expand() geometry.
  const openMenu = useCallback(async () => {
    setMenu(true)
    const p = await nativeBridge.orbGetPosition().catch(() => posRef.current)
    posRef.current = p
    savePos(p.x, p.y)
    const mon = await nativeBridge.orbGetMonitorBounds()
    const above = p.y + WINDOW - MENU_H >= mon.y
    const nx = Math.min(
      Math.max(p.x + WINDOW / 2 - MENU_W / 2, mon.x),
      mon.x + mon.width - MENU_W,
    )
    const ny = above ? p.y - (MENU_H - WINDOW) : p.y
    await applySizePos(MENU_W, MENU_H, nx, ny)
    posRef.current = { x: nx, y: ny }
  }, [applySizePos])

  const closeMenu = useCallback(async () => {
    setMenu(false)
    await collapse()
  }, [collapse])

  // ---------- actions ----------
  const restore = useCallback(() => {
    void nativeBridge.restoreFromOrb()
  }, [])
  const quit = useCallback(() => {
    void nativeBridge.quit()
  }, [])

  // Restore saved position on boot (after Rust's bottom-right default).
  useEffect(() => {
    const saved = loadPos()
    if (saved && (saved.x !== 0 || saved.y !== 0)) {
      posRef.current = saved
      void applySizePos(WINDOW, WINDOW, saved.x, saved.y)
    }
  }, [applySizePos])

  // ---------- pointer: drag vs click ----------
  const beginDrag = useCallback(() => {
    void nativeBridge.orbStartDrag().catch(() => {
      /* drag unavailable — nothing to do */
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
    if (dragPending.current && (Math.abs(e.movementX) > 2 || Math.abs(e.movementY) > 2)) {
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
    if (wasClick) restore()
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        restore()
      } else if (e.key === "Escape") {
        void closeMenu()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [restore, closeMenu, clearLeaveTimer])

  const visibleCount = rows.length
  const status = aggregate(rows)
  const ringClassName = ring(status, visibleCount > 0)

  const onRootPointerEnter = () => {
    if (menu) return
    clearLeaveTimer()
    hoverRef.current = true
    void expand()
  }
  const onRootPointerLeave = () => {
    if (menu) return
    hoverRef.current = false
    // Debounce so moving from circle into the card (both inside the window)
    // never collapses underneath the user.
    clearLeaveTimer()
    leaveTimer.current = window.setTimeout(() => {
      if (!hoverRef.current) void collapse()
    }, 240)
  }

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{ background: "transparent", fontFamily: "var(--font-sans)" }}
      onPointerEnter={onRootPointerEnter}
      onPointerLeave={onRootPointerLeave}
    >
      {/* live card area (height 0 until expanded) */}
      <div className="min-h-0 flex-1 overflow-hidden px-2 pt-2">
        {menu ? (
          <div className="flex h-full flex-col justify-end pb-1">
            <div className="rounded-xl border border-white/10 bg-[#0b0b0e] p-1 shadow-[0_12px_40px_rgba(0,0,0,0.6)]">
              <button
                className="block w-full rounded-lg px-3 py-2 text-left text-[13px] text-still-fg hover:bg-white/5"
                onClick={() => {
                  void closeMenu().then(() => restore())
                }}
              >
                Restore window
              </button>
              <div className="my-1 h-px bg-white/10" />
              <button
                className="block w-full rounded-lg px-3 py-2 text-left text-[13px] text-[#ff6b6b] hover:bg-white/5"
                onClick={() => {
                  setMenu(false)
                  quit()
                }}
              >
                Quit Still
              </button>
            </div>
          </div>
        ) : (
          rows.length > 0 && (
            <div className="flex h-full flex-col">
              <div className="mb-1 flex items-baseline justify-between px-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-still-faint">
                  live
                </span>
                <span className="font-mono text-[10px] text-still-faint">
                  {rows.length}/{rows.length}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-0.5">
                {rows.map((r) => (
                  <div
                    key={r.sessionId}
                    className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1.5"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background:
                          r.status === "needs-input"
                            ? "#f5b942"
                            : r.status === "working"
                              ? "#ff6b6b"
                              : r.status === "done"
                                ? "#4ade80"
                                : r.status === "error"
                                  ? "#ff4a4a"
                                  : "rgba(255,255,255,0.25)",
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-still-fg">
                          {r.name}
                        </span>
                        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-still-faint">
                          {STATUS_LABEL[r.status]}
                        </span>
                      </div>
                      <div className="truncate text-[10px] text-still-dim">{r.snippet}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </div>

      {/* floating circle strip */}
      <div className="flex h-[128px] w-full shrink-0 items-center justify-center">
        <button
          type="button"
          onPointerDown={(e) => onPointerDown(e)}
          onPointerMove={(e) => onPointerMove(e)}
          onPointerUp={(e) => onPointerUp(e)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (menu) void closeMenu()
            else void openMenu()
          }}
          aria-label={`Still — ${rows.length} live session${rows.length === 1 ? "" : "s"}`}
          // Flat translucent fill, NO backdrop-blur: WebView2 renders blur
          // over a transparent window as a black smear (the "black box").
          className={`group relative grid select-none place-items-center rounded-full border bg-[rgba(5,5,5,0.88)] p-0 shadow-[0_0_0_1px_rgba(255,255,255,0.06)] transition-transform duration-200 ${ringClassName} hover:scale-[1.06] active:scale-[0.96]`}
          style={{ width: ORB, height: ORB }}
        >
          {/* inner "still" mark */}
          <span className="pointer-events-none h-[30px] w-[30px] rounded-full border border-white/10 transition-colors duration-300 group-hover:border-white/25" />
          <span className="pointer-events-none absolute bottom-[16px] left-1/2 h-[3px] w-[20px] -translate-x-1/2 rounded-full bg-white/25" />

          {/* status ember */}
          <span
            className={`pointer-events-none absolute right-[10px] top-[10px] h-2.5 w-2.5 rounded-full ${
              status === "needs-input"
                ? "bg-[#f5b942]"
                : status === "working"
                  ? "bg-[#ff6b6b]"
                  : status === "done"
                    ? "bg-[#4ade80]"
                    : status === "error"
                      ? "bg-[#ff4a4a]"
                      : "bg-white/25"
            }`}
          />
          {/* live count badge */}
          {visibleCount > 0 && (
            <span className="pointer-events-none absolute right-0 top-0 grid h-[19px] min-w-[18px] -translate-y-1/2 translate-x-1/2 place-items-center rounded-full bg-[#ff4a4a] px-1 font-mono text-[10px] font-bold leading-none text-[#08080a]">
              {visibleCount}
            </span>
          )}
          {/* breathing wash while a session is actively working */}
          {status === "working" && (
            <span className="pointer-events-none absolute inset-0 rounded-full bg-[#ff4a4a]/10 orb-wash" />
          )}
        </button>
      </div>

      {/* menu now lives in the card area (window grows to fit it) — the old
          absolute overlay clipped against the 128px OS window. */}
      <style>{`
        @keyframes orb-wash {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 0.9; transform: scale(1.05); }
        }
        .orb-wash { animation: orb-wash 2.4s ease-in-out infinite; }
      `}</style>
    </div>
  )
}
