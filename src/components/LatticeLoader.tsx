import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import "./LatticeLoader.css"

export type LatticeStatus = "working" | "done" | "error"
export type LatticePatternName = "arrow" | "dots" | "orbit" | "ripple" | "snake" | "spiral" | "sweep" | "spin" | "rain" | "pulse"
export type LatticeGrid = 3 | 4
export interface LatticePattern { cells: (number | null)[]; loop?: number; scale?: number; lit?: 0.25 | 0.35 | 0.45 | 0.62 }
export interface LatticeLoaderProps {
  label?: string
  doneLabel?: string
  errorLabel?: string
  status?: LatticeStatus
  pattern?: LatticePatternName | LatticePattern
  grid?: LatticeGrid
  shape?: "square" | "round"
  color?: string
  doneColor?: string
  errorColor?: string
  cellSize?: number
  gap?: number
  fontSize?: number
  step?: number
  idleOpacity?: number
  glow?: boolean
  glowColor?: string
  showTimer?: boolean
  elapsed?: number
  announce?: boolean
  className?: string
  style?: CSSProperties
}

type ResolvedPattern = { cells: (number | null)[]; loop: number; scale: number; lit?: number }
const PATTERNS: Record<LatticePatternName, Partial<Record<LatticeGrid, ResolvedPattern>>> = {
  arrow: { 3: { cells: [1, 2, 3, 0, 1, 2, 1, 2, 3], loop: 7.2, scale: 1 } },
  dots: { 3: { cells: [0, 1, 2, 0, 1, 2, 0, 1, 2], loop: 3, scale: 2.4 } },
  ripple: { 3: { cells: [2, 1, 2, 1, 0, 1, 2, 1, 2], loop: 4.8, scale: 1.5 } },
  spiral: { 3: { cells: [0, 1, 2, 7, 8, 3, 6, 5, 4], loop: 9, scale: 1.2, lit: .35 } },
  orbit: {
    3: { cells: [0, 1, 2, 7, null, 3, 6, 5, 4], loop: 8, scale: 1.2 },
    4: { cells: [0, 1, 2, 3, 11, null, null, 4, 10, null, null, 5, 9, 8, 7, 6], loop: 6, scale: 1.2, lit: .45 },
  },
  snake: {
    3: { cells: [0, 1, 2, 5, 4, 3, 6, 7, 8], loop: 9, scale: 1, lit: .35 },
    4: { cells: [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12], loop: 16, scale: 1, lit: .25 },
  },
  sweep: { 4: { cells: [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6], loop: 5, scale: 1, lit: .45 } },
  spin: { 4: { cells: [0, 0, 1, 1, 0, 0, 1, 1, 3, 3, 2, 2, 3, 3, 2, 2], loop: 4, scale: 1.6, lit: .35 } },
  rain: { 4: { cells: [0, 2, 1, 3, 1, 3, 2, 4, 2, 4, 3, 5, 3, 5, 4, 6], loop: 4, scale: 1.2, lit: .35 } },
  pulse: { 4: { cells: [2, 1, 1, 2, 1, 0, 0, 1, 1, 0, 0, 1, 2, 1, 1, 2], loop: 2.4, scale: 2.5, lit: .45 } },
}
const DEFAULT_PATTERN: Record<LatticeGrid, LatticePatternName> = { 3: "orbit", 4: "sweep" }
const MARKS: Record<LatticeGrid, Record<"done" | "error", number[]>> = {
  3: { done: [2, 3, 5, 7], error: [0, 2, 4, 6, 8] },
  4: { done: [7, 8, 10, 13], error: [0, 3, 5, 6, 9, 10, 12, 15] },
}
function resolvePattern(pattern: LatticePatternName | LatticePattern, grid: LatticeGrid): ResolvedPattern {
  if (typeof pattern === "string") return PATTERNS[pattern][grid] || PATTERNS[DEFAULT_PATTERN[grid]][grid]!
  const cells = Array.from({ length: grid * grid }, (_, index) => pattern.cells[index] ?? null)
  const max = Math.max(0, ...cells.filter((value): value is number => value != null))
  return { cells, loop: pattern.loop ?? max + 4.2, scale: pattern.scale ?? 1, lit: pattern.lit ?? .62 }
}
const formatDuration = (deciseconds: number) => deciseconds < 600
  ? `${(deciseconds / 10).toFixed(1)}s`
  : `${Math.floor(deciseconds / 600)}m ${((deciseconds % 600) / 10).toFixed(1)}s`
const spokenDuration = (deciseconds: number) => deciseconds < 600
  ? `${(deciseconds / 10).toFixed(1)} seconds`
  : `${Math.floor(deciseconds / 600)} minutes ${((deciseconds % 600) / 10).toFixed(1)} seconds`

/** Compact lattice status mark for ongoing work and terminal outcomes. */
export default function LatticeLoader({
  label = "Thinking", doneLabel = "Thought", errorLabel = "Stopped early", status = "working",
  pattern = "orbit", grid = 3, shape = "round", color = "currentColor", doneColor = "#e7c0cb",
  errorColor = "#e9808e", cellSize = 3, gap = 1.5, fontSize = 12, step = 95,
  idleOpacity = .16, glow = false, glowColor = "", showTimer = false, elapsed, announce = true,
  className = "", style,
}: LatticeLoaderProps) {
  const size: LatticeGrid = grid === 4 ? 4 : 3
  const resolved = resolvePattern(pattern, size), marks = MARKS[size]
  const interval = step * resolved.scale, cycle = Math.round(resolved.loop * interval)
  const timer = useRef<HTMLSpanElement>(null), elapsedRef = useRef(0), marked = useRef<"done" | "error">("done")
  const [announcement, setAnnouncement] = useState(`${label}, in progress`)
  marked.current = status === "working" ? marked.current : status

  useLayoutEffect(() => {
    if (elapsed != null) {
      elapsedRef.current = Math.round(elapsed * 10)
      if (timer.current) timer.current.textContent = formatDuration(elapsedRef.current)
      return
    }
    if (status !== "working" || !showTimer) return
    const start = performance.now()
    const tick = () => {
      elapsedRef.current = Math.floor((performance.now() - start) / 100)
      if (timer.current) timer.current.textContent = formatDuration(elapsedRef.current)
    }
    tick()
    const id = window.setInterval(tick, 100)
    return () => window.clearInterval(id)
  }, [status, elapsed, showTimer])

  useEffect(() => {
    setAnnouncement(status === "working" ? `${label}, in progress` : `${status === "done" ? doneLabel : errorLabel}${showTimer ? ` ${spokenDuration(elapsedRef.current)}` : ""}`)
  }, [status, label, doneLabel, errorLabel, showTimer])

  return <span role={announce ? "status" : undefined} aria-live={announce ? "polite" : undefined} className={`lattice-loader${className ? ` ${className}` : ""}`} data-status={status} data-shape={shape} data-glow={glow ? "" : undefined}
    style={{ "--ll-n": size, "--ll-cell": `${cellSize}px`, "--ll-gap": `${gap}px`, "--ll-font": `${fontSize}px`, "--ll-color": color, "--ll-mark": status === "error" ? errorColor : doneColor, "--ll-idle": idleOpacity, "--ll-glow": glowColor || color, "--ll-mark-glow": glowColor || (status === "error" ? errorColor : doneColor), "--ll-cycle": `${cycle}ms`, ...style } as CSSProperties}>
    <span className="lattice-loader__grid" aria-hidden="true">
      <span className="lattice-loader__layer lattice-loader__run">{resolved.cells.map((unit, index) => <span key={index} className="lattice-loader__cell" data-hole={unit == null ? "" : undefined} style={unit == null ? undefined : { animationDelay: `${Math.round(unit * interval)}ms` }} />)}</span>
      <span className="lattice-loader__layer lattice-loader__mark">{resolved.cells.map((_, index) => <span key={index} className="lattice-loader__cell" data-on={status !== "working" && marks[marked.current].includes(index) ? "" : undefined} />)}</span>
    </span>
    <span className="lattice-loader__label" aria-hidden="true"><span className="lattice-loader__text">{status === "working" ? label : status === "done" ? doneLabel : errorLabel}</span></span>
    {showTimer && <span ref={timer} className="lattice-loader__timer" aria-hidden="true">0.0s</span>}
    <span className="agent-sr-only">{announcement}</span>
  </span>
}
