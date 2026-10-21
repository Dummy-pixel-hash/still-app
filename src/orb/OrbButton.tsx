import { useRef, type CSSProperties, type RefObject } from "react"
import SmokedGlassOrb, { OrbStateIcon } from "./SmokedGlassOrb"
import type { OrbSpeed, OrbVisualState } from "./types"

/** Shared mouse/touch/keyboard semantics; OS and browser placement stay separate. */
export default function OrbButton({
  size, state, paused, speed, label, title, activate, menu, drag, nudge, style, buttonRef, menuOpen, nativeDrag = false, interact,
}: {
  size: number
  state: OrbVisualState
  paused: boolean
  speed: OrbSpeed
  label: string
  title: string
  activate(): void
  menu(): void
  /** Cumulative offset from pointerdown. Native implementation starts once. */
  drag(dx: number, dy: number, first: boolean): void
  nudge(dx: number, dy: number): void
  style?: CSSProperties
  buttonRef?: RefObject<HTMLButtonElement | null>
  menuOpen?: boolean
  nativeDrag?: boolean
  interact?(): void
}) {
  const gesture = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null)
  const suppressClick = useRef(false)
  return <button
    ref={buttonRef}
    type="button"
    className="orb-button"
    data-state={state}
    style={{ width: size, height: size, ...style }}
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    title={title}
    onPointerDown={event => {
      if (!event.isPrimary) return
      interact?.()
      if (event.button !== 0) return
      suppressClick.current = false
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false }
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* OS still owns native dragging. */ }
    }}
    onPointerMove={event => {
      const pending = gesture.current
      if (!pending || pending.id !== event.pointerId) return
      const dx = event.clientX - pending.x, dy = event.clientY - pending.y
      if (!pending.dragging && Math.hypot(dx, dy) < 5) return
      const first = !pending.dragging
      pending.dragging = true
      suppressClick.current = true
      if (first && nativeDrag && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      drag(dx, dy, first)
    }}
    onPointerUp={event => {
      if (gesture.current?.id !== event.pointerId) return
      gesture.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={() => { gesture.current = null; suppressClick.current = true }}
    onLostPointerCapture={() => { if (gesture.current) suppressClick.current = true; gesture.current = null }}
    onClick={event => {
      if (event.detail !== 0 && suppressClick.current) return
      activate()
    }}
    onContextMenu={event => { event.preventDefault(); menu() }}
    onKeyDown={event => {
      const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      if (event.key in directions) {
        event.preventDefault(); event.stopPropagation()
        const step = event.shiftKey ? 20 : 8
        const [x, y] = directions[event.key]
        nudge(x * step, y * step)
      } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); event.stopPropagation(); menu()
      }
    }}
  >
    <SmokedGlassOrb state={state} size={size} paused={paused} speed={speed} />
    <span className="orb-state-mark"><OrbStateIcon state={state} /></span>
  </button>
}
