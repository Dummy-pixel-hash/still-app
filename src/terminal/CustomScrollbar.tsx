import { useCallback, useEffect, useRef } from "react"
import type { Terminal } from "@xterm/xterm"

/**
 * Custom scroll indicator — the ONLY scrollbar (xterm 6's legacy native
 * track and VS Code-style slider are both hidden in theme.css).
 *
 * Design: a 6px rounded thumb living in the lane FitAddon reserves via
 * `overviewRuler.width`, so text never sits under it and the 14px stock
 * reserve is reclaimed (6px lane instead).
 *
 * Driven by one rAF loop: reads the active buffer each frame, writes the
 * thumb's geometry only when the position actually changed — frame-rate
 * smooth with zero React re-renders. Fades out after 600ms idle. Dragging
 * maps pointer position onto the scrollback and scrolls via the public
 * `scrollLines` API. `prefers-reduced-motion` is honored by the global
 * rule in theme.css, which also zeroes the fade transition.
 */
const FADE_MS = 600
const MIN_THUMB = 28 // px — keeps the thumb grabbable on deep buffers

export default function CustomScrollbar({ terminal }: { terminal: Terminal | null }) {
  const laneRef = useRef<HTMLDivElement | null>(null)
  const thumbRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef(0)
  const fadeTimer = useRef(0)
  // Last painted thumb geometry; skips redundant style writes.
  const lastTop = useRef(-1)
  const lastThumbH = useRef(-1)
  const dragging = useRef(false)

  // Component scope so BOTH the rAF tick and the pointer-drag handlers can
  // wake it (a local definition inside the mount effect is unreachable from
  // onPointerDown). Reads/writes refs only, so it never needs to change.
  const poke = useCallback(() => {
    // Visible while content moves (or while dragged); fades out after idle.
    const lane = laneRef.current
    if (!lane) return
    if (lane.style.opacity !== "1" || dragging.current) {
      lane.style.opacity = "1"
    }
    window.clearTimeout(fadeTimer.current)
    fadeTimer.current = window.setTimeout(() => {
      if (!dragging.current && laneRef.current) {
        laneRef.current.style.opacity = "0"
      }
    }, FADE_MS)
  }, [])

  useEffect(() => {
    if (!terminal) return

    let alive = true

    const tick = () => {
      if (!alive) return
      const lane = laneRef.current
      const thumb = thumbRef.current
      if (lane && thumb) {
        try {
          const buffer = terminal.buffer.active
          const lines = buffer.length
          const rows = terminal.rows
          const ydisp = buffer.viewportY
          const maxScroll = lines - rows
          // Alternate buffer (vim/less/tmux copy-mode) has no local
          // scrollback — tmux owns that scrolling, so the lane hides.
          if (buffer.type !== "normal" || maxScroll <= 0) {
            if (lastTop.current !== -1) {
              lastTop.current = -1
              lastThumbH.current = -1
              lane.style.opacity = "0"
              lane.style.pointerEvents = "none"
            }
          } else {
            lane.style.pointerEvents = "auto"
            const track = lane.clientHeight
            const thumbH = Math.min(track, Math.max(MIN_THUMB, Math.round((track * rows) / lines)))
            const top =
              ydisp <= 0
                ? 0
                : ydisp >= maxScroll
                  ? track - thumbH
                  : Math.round((ydisp / maxScroll) * (track - thumbH))
            if (top !== lastTop.current || thumbH !== lastThumbH.current) {
              lastTop.current = top
              lastThumbH.current = thumbH
              thumb.style.height = `${thumbH}px`
              thumb.style.transform = `translateY(${top}px)`
            }
            poke()
          }
        } catch {
          // Terminal disposed mid-frame; unmount ends the loop.
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      alive = false
      window.clearTimeout(fadeTimer.current)
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    }
  }, [terminal])

  // Drag: pointer position maps onto scrollback; page-clicks above/below
  // the thumb jump a viewport toward the click. Pointer capture keeps the
  // gesture on the lane even when the cursor leaves it.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!terminal || e.button !== 0) return
    const lane = laneRef.current
    const thumb = thumbRef.current
    if (!lane || !thumb) return
    const buffer = terminal.buffer.active
    const maxScroll = buffer.length - terminal.rows
    if (buffer.type !== "normal" || maxScroll <= 0) return
    e.preventDefault()
    lane.setPointerCapture(e.pointerId)
    dragging.current = true

    const moveTo = (clientY: number) => {
      const track = lane.clientHeight
      const thumbH = thumb.getBoundingClientRect().height
      const rect = lane.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top - thumbH / 2) / (track - thumbH)))
      const target = Math.round(ratio * maxScroll)
      const delta = target - terminal.buffer.active.viewportY
      if (delta !== 0) terminal.scrollLines(delta)
    }
    // Thumb drag or track click both steer the same way: the pointer
    // position maps onto the scrollback (track clicks jump immediately).
    moveTo(e.clientY)

    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return
      ev.preventDefault()
      poke()
      moveTo(ev.clientY)
    }
    const onUp = () => {
      dragging.current = false
      lane.removeEventListener("pointermove", onMove)
      window.clearTimeout(fadeTimer.current)
      fadeTimer.current = window.setTimeout(() => {
        if (laneRef.current && !dragging.current) laneRef.current.style.opacity = "0"
      }, FADE_MS)
    }
    lane.addEventListener("pointermove", onMove, { passive: false })
    lane.addEventListener("pointerup", onUp, { once: true })
    lane.addEventListener("pointercancel", onUp, { once: true })
  }

  return (
    <div
      ref={laneRef}
      aria-hidden
      onPointerDown={onPointerDown}
      className="absolute bottom-0 right-0 top-0 z-20 w-3 cursor-default transition-opacity duration-200"
      style={{ opacity: 0 }}
    >
      <div
        ref={thumbRef}
        className="absolute right-[3px] w-[6px] rounded-full bg-white/25 hover:bg-white/40"
        style={{ height: 28, transform: "translateY(0px)" }}
      />
    </div>
  )
}
