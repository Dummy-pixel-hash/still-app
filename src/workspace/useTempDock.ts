import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react"
import { MORPH_MS, type OpenState } from "../components/TerminalOverlay"
import { releaseSession } from "../session/connections"
import { setSessionAppearance, forgetTempAppearance } from "../session/store"
import { prefersReducedMotion } from "./motion"
import { tempPill } from "./focusTargets"
import type { Session } from "../types"

export const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
/** Keep the last tile's rounded edge off the viewport edge. */
const TEMP_DOCK_GUTTER = 2
/** A tile cannot be dragged below this height (or half the dock, if smaller). */
const TEMP_MIN_TILE_H = 120
/** The dock's exit animation; the node stays mounted for exactly this long. */
const TEMP_DOCK_EXIT_MS = 220

interface TempTile {
  id: string
  top: number
  height: number
}

/**
 * Temp dock geometry from proportional weights, not stored pixels: adding,
 * minimizing, or resizing the window redistributes every tile while keeping
 * the user's ratios. An empty/missing weight is one fair share.
 */
function layoutTempTiles(
  list: Session[],
  sizes: Record<string, number>,
  viewportHeight: number,
): TempTile[] {
  const usable = Math.max(0, viewportHeight - TEMP_DOCK_GUTTER)
  const weights = list.map((s) => {
    const w = sizes[s.id]
    return Number.isFinite(w) && w > 0 ? w : 1
  })
  const total = weights.reduce((sum, w) => sum + w, 0)
  let top = 0
  return list.map((s, i) => {
    const height = total > 0 ? (weights[i] / total) * usable : usable / Math.max(1, list.length)
    const tile = { id: s.id, top, height }
    top += height
    return tile
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Where the dock will rest before its first temp mounts. The first temp is
 * created while the dock is still absent, so the overlay morphs out of the
 * same bottom-right corner the dock is about to occupy.
 */
function tempDockAnchorRect(): DOMRect {
  const width = Math.min(302, Math.max(0, window.innerWidth - 40))
  const height = 72
  return new DOMRect(
    window.innerWidth - 20 - width,
    window.innerHeight - 20 - height,
    width,
    height,
  )
}


export interface AuthState {
  session: Session
  mode: "password" | "key"
  resolve: (a: { secret?: string; remember: boolean } | null) => void
}

/** Temp terminals: memory-only scratch sessions docked beside main. Extracted from Workspace unchanged. */
export function useTempDock({
  open,
  sessions,
  authForRef,
  setAuthFor,
  agentsOpen,
}: {
  open: OpenState | null
  sessions: Session[]
  authForRef: MutableRefObject<AuthState | null>
  setAuthFor: (a: AuthState | null) => void
  agentsOpen: boolean
}) {
  const store = { sessions }
  // Temp terminals: arrays of memory-only scratch sessions, each docked in
  // its own overlay beside main. Minimize hides the view (worker +
  // transcript survive). The dock only exists while at least one temp does.
  const [temps, setTemps] = useState<Session[]>([])
  const [openTemps, setOpenTemps] = useState<Record<string, OpenState>>({})
  // Keep the dock mounted through its exit animation, then drop it (and its
  // focusables) entirely so an empty workspace has no ghost controls.
  const [tempDockMounted, setTempDockMounted] = useState(false)
  // Last populated dock, retained for the exit fade: killing the final temp
  // should dissolve the whole panel, not collapse it to a bare header first.
  const dockTempsRef = useRef<Session[]>([])
  const hasTemps = temps.length > 0
  const dockTemps = hasTemps ? temps : dockTempsRef.current

  // Per-temp dock weights (arbitrary proportional units). A missing entry is
  // one fair share, so new/minimized/restored tiles self-heal their layout.
  const [tempSizes, setTempSizes] = useState<Record<string, number>>({})
  const [dockViewportH, setDockViewportH] = useState(() => window.innerHeight)
  const [isResizing, setIsResizing] = useState(false)
  // Open-temp count gates the single-temp main↔temp split (see render below).
  const openTempCount = Object.keys(openTemps).length
  // Latest pointer Y per drag; a single rAF applies it so fast mice cannot
  // queue more React renders than the display can paint.
  const resizeDrag = useRef<{
    topId: string
    bottomId: string
    pointerId: number
    startY: number
    topStart: number
    bottomStart: number
    pendingY: number
    frame: number
  } | null>(null)
  const resizeReleaseFrame = useRef(0)
  // Monotonic per-app-session counter: temp names stay unique even after
  // earlier temps are killed.
  const tempSeq = useRef(0)
  useEffect(
    () => () => {
      window.cancelAnimationFrame(resizeReleaseFrame.current)
      const drag = resizeDrag.current
      if (drag?.frame) window.cancelAnimationFrame(drag.frame)
      document.body.classList.remove("still-resizing-temp")
    },
    [],
  )

  // Inline dock geometry is in px, so track the real viewport while the
  // window is being resized. One update per frame keeps it in step with the
  // compositor without turning a window drag into a render storm.
  useEffect(() => {
    let frame = 0
    const sync = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => setDockViewportH(window.innerHeight))
    }
    window.addEventListener("resize", sync)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("resize", sync)
    }
  }, [])

  // Remember the live rows while the dock exists; the exit render reads this
  // snapshot because `temps` is already empty by then.
  useEffect(() => {
    if (hasTemps) dockTempsRef.current = temps
  }, [hasTemps, temps])

  // Mount on the first temp; after the last one is killed, hold the node for
  // its exit animation before removing it. Re-entry (a new temp during the
  // fade) cancels the pending unmount and plays the entrance again.
  useEffect(() => {
    if (hasTemps) {
      setTempDockMounted(true)
      return
    }
    if (!tempDockMounted) return
    const timer = window.setTimeout(
      () => setTempDockMounted(false),
      prefersReducedMotion() ? 0 : TEMP_DOCK_EXIT_MS,
    )
    return () => window.clearTimeout(timer)
  }, [hasTemps, tempDockMounted])

  // Center/pill-origin morph for a temp overlay (it has no card). Docked next
  // to main. Sets the entry for this temp id only so others stay open.
  const morphTemp = (s: Session, el: HTMLElement | null, autoConnect = true) => {
    const id = s.id
    const rect =
      el?.getBoundingClientRect() ?? tempDockAnchorRect()
    setOpenTemps((o) => ({ ...o, [id]: { session: s, rect, phase: "enter", autoConnect } }))
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setOpenTemps((o) =>
          o[id]?.session.id === id
            ? { ...o, [id]: { ...o[id], phase: "open" } }
            : o,
        ),
      ),
    )
  }

  const minimizeTemp = useCallback((id: string) => {
    const pending = authForRef.current
    // Only THIS temp's dialog may be cancelled: minimizing one temp must
    // never discard another temp's pending auth promise.
    if (pending && pending.session.id === id) {
      authForRef.current = null
      setAuthFor(null)
      pending.resolve(null)
    }
    // Instant hide; worker + transcript survive. Only this temp's overlay is
    // removed, so the rest of the dock keeps running.
    setOpenTemps((o) => {
      const next = { ...o }
      delete next[id]
      return next
    })
  }, [])

  const killTemp = useCallback((id: string) => {
    minimizeTemp(id) // cancels temp-scoped auth, hides view
    setTemps((ts) => ts.filter((t) => t.id !== id))
    setTempSizes((z) => {
      const next = { ...z }
      delete next[id]
      return next
    })
    void releaseSession(id)
    forgetTempAppearance(id)
  }, [minimizeTemp])

  // Only currently OPEN temps take part in the dock geometry. Minimized temps
  // keep their weight, so restoring one returns to the same relative size.
  const openTempList = temps.filter((t) => openTemps[t.id])
  const tempLayout = layoutTempTiles(openTempList, tempSizes, dockViewportH)

  // Apply the latest pointer position at most once per painted frame. The
  // boundary is moved in pixels from the snapshot, and the pair's total height
  // is held constant, so the dock never jumps or leaves a gap mid-drag.
  const applyResize = useCallback((clientY: number) => {
    const drag = resizeDrag.current
    if (!drag) return
    const span = drag.topStart + drag.bottomStart
    if (span <= 0) return
    // Never force an already-small tile (e.g. after a window shrink) to grow
    // just because its divider was grabbed; only prevent it shrinking further.
    const minTop = Math.min(TEMP_MIN_TILE_H, drag.topStart)
    const minBottom = Math.min(TEMP_MIN_TILE_H, drag.bottomStart)
    const nextTop = clamp(drag.topStart + (clientY - drag.startY), minTop, span - minBottom)
    const nextBottom = span - nextTop
    setTempSizes((sizes) =>
      sizes[drag.topId] === nextTop && sizes[drag.bottomId] === nextBottom
        ? sizes
        : { ...sizes, [drag.topId]: nextTop, [drag.bottomId]: nextBottom },
    )
  }, [])

  const startResize =
    (topId: string, bottomId: string) =>
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const top = tempLayout.find((tile) => tile.id === topId)
      const bottom = tempLayout.find((tile) => tile.id === bottomId)
      if (!top || !bottom) return
      window.cancelAnimationFrame(resizeReleaseFrame.current)
      // Convert every open tile to its current pixel height once, so this
      // drag and any later tile additions share one comparable weight scale.
      setTempSizes((sizes) => {
        const next = { ...sizes }
        for (const tile of tempLayout) next[tile.id] = Math.max(1, tile.height)
        return next
      })
      resizeDrag.current = {
        topId,
        bottomId,
        pointerId: e.pointerId,
        startY: e.clientY,
        topStart: top.height,
        bottomStart: bottom.height,
        pendingY: e.clientY,
        frame: 0,
      }
      setIsResizing(true)
      document.body.classList.add("still-resizing-temp")
      try {
        // Capture keeps the drag alive once the pointer leaves the 8px band.
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // Already released by the compositor; the next move ends the drag.
      }
    }

  const moveResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current
    if (!drag || drag.pointerId !== e.pointerId) return
    drag.pendingY = e.clientY
    if (drag.frame) return
    drag.frame = window.requestAnimationFrame(() => {
      const active = resizeDrag.current
      if (!active) return
      active.frame = 0
      applyResize(active.pendingY)
    })
  }

  const endResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (drag.frame) {
      window.cancelAnimationFrame(drag.frame)
      drag.frame = 0
    }
    applyResize(e.clientY)
    resizeDrag.current = null
    document.body.classList.remove("still-resizing-temp")
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      // Pointer already released by the compositor.
    }
    // Keep transitions off through the final commit; turning them back on in
    // the same batch would animate the last few pixels after the pointer up.
    window.cancelAnimationFrame(resizeReleaseFrame.current)
    resizeReleaseFrame.current = window.requestAnimationFrame(() =>
      setIsResizing(false),
    )
  }
  // Main↔temp split (single temp only): the divider's x as a fraction of
  // viewport width (0..1). The single temp fills the remainder, so moving the
  // divider is the one knob between main and temp.
  const splitDrag = useRef(false)
  const splitFrame = useRef(0)
  const [mainRatio, setMainRatio] = useState(0.5)
  const startSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    splitDrag.current = true
    window.cancelAnimationFrame(splitFrame.current)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Compositor already released; the next move ends the drag.
    }
  }
  const moveSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitDrag.current) return
    const w = window.innerWidth || 1
    const r = clamp(e.clientX / w, 0.3, 0.8)
    if (r === mainRatio) return
    window.cancelAnimationFrame(splitFrame.current)
    splitFrame.current = window.requestAnimationFrame(() => setMainRatio(r))
  }
  const endSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    splitDrag.current = false
    window.cancelAnimationFrame(splitFrame.current)
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      // Pointer already released by the compositor.
    }
    // Keep transitions off through the final commit so the width/position
    // jump to rest instead of morphing over the 650ms easing curve.
    window.cancelAnimationFrame(resizeReleaseFrame.current)
    resizeReleaseFrame.current = window.requestAnimationFrame(() =>
      setIsResizing(false),
    )
  }
  const splitKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.08 : 0.02
    let next = mainRatio
    if (e.key === "ArrowLeft") {
      next = clamp(mainRatio - step, 0.3, 0.8)
      e.preventDefault()
    } else if (e.key === "ArrowRight") {
      next = clamp(mainRatio + step, 0.3, 0.8)
      e.preventDefault()
    } else if (e.key === "Home") {
      next = 0.3
      e.preventDefault()
    } else if (e.key === "End") {
      next = 0.8
      e.preventDefault()
    } else {
      return
    }
    e.stopPropagation()
    window.cancelAnimationFrame(resizeReleaseFrame.current)
    setIsResizing(true)
    resizeReleaseFrame.current = window.requestAnimationFrame(() =>
      setMainRatio(next),
    )
  }

  const nudgeResize = (topId: string, bottomId: string, delta: number) => {
    const top = tempLayout.find((tile) => tile.id === topId)
    const bottom = tempLayout.find((tile) => tile.id === bottomId)
    if (!top || !bottom) return
    const span = top.height + bottom.height
    const minTop = Math.min(TEMP_MIN_TILE_H, top.height)
    const minBottom = Math.min(TEMP_MIN_TILE_H, bottom.height)
    const nextTop = clamp(top.height + delta, minTop, span - minBottom)
    // Keyboard steps are direct manipulation too: apply the new height for
    // this commit with the morph transition off, then restore it next frame.
    window.cancelAnimationFrame(resizeReleaseFrame.current)
    setIsResizing(true)
    resizeReleaseFrame.current = window.requestAnimationFrame(() =>
      setIsResizing(false),
    )
    setTempSizes((sizes) => {
      const next = { ...sizes }
      for (const tile of tempLayout) next[tile.id] = Math.max(1, tile.height)
      next[topId] = nextTop
      next[bottomId] = span - nextTop
      return next
    })
  }

  const resizeKeyDown =
    (topId: string, bottomId: string) =>
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 64 : 16
      if (e.key === "ArrowUp") {
        e.preventDefault()
        e.stopPropagation()
        nudgeResize(topId, bottomId, -step)
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        e.stopPropagation()
        nudgeResize(topId, bottomId, step)
      } else if (e.key === "Home") {
        e.preventDefault()
        e.stopPropagation()
        nudgeResize(topId, bottomId, Number.NEGATIVE_INFINITY)
      } else if (e.key === "End") {
        e.preventDefault()
        e.stopPropagation()
        nudgeResize(topId, bottomId, Number.POSITIVE_INFINITY)
      }
    }

  const toggleTemp = useCallback(() => {
    if (authForRef.current) return // main dialog up; retry after it resolves
      // Ctrl/Cmd+Shift+T always opens a new temp terminal. Names use a
    // monotonic counter so they never collide after kills; ids stay
    // temp-* guarded so main-close never kills them.
    const src =
      open?.session ??
      [...store.sessions].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0]
    if (!src) return
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    tempSeq.current += 1
    const s: Session = {
      ...src,
      id: `temp-${stamp}`,
      name: `Temp ${tempSeq.current} ${src.name}`,
      projectId: "",
      tmuxSession: `still-tmp-${stamp.replace(/[^A-Za-z0-9_-]/g, "")}`,
      remember: false,
    }
    // A temp inherits the source's theme/zoom override (temps are memory-only,
    // so their overrides live beside them, not in the saved session).
    setSessionAppearance(s.id, { terminalTheme: src.terminalTheme, fontSize: src.fontSize })
    setTemps((ts) => [...ts, s])
    morphTemp(s, null)

    // A new tile takes one fair share of the *current* open weights: existing
    // ratios survive, and nothing can be smaller than a reasonable minimum.
    setTempSizes((sizes) => {
      const openWeights = Object.keys(openTemps)
        .map((id) => sizes[id])
        .filter((w): w is number => Number.isFinite(w) && w > 0)
      const weight = openWeights.length
        ? openWeights.reduce((sum, w) => sum + w, 0) / openWeights.length
        : 1
      return { ...sizes, [s.id]: weight }
    })
  }, [open, openTemps, store.sessions, temps.length])
  // Temp toggle on capture: runs before xterm sees the key so the combo
  // never leaks bytes into the PTY (same pattern as the overlay gate).
  const toggleRef = useRef(toggleTemp)
  toggleRef.current = toggleTemp
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (agentsOpen) return
      if (e.repeat) return
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== "t") return
      e.preventDefault()
      e.stopPropagation()
      toggleRef.current()
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [agentsOpen])

  /** Minimize and hand focus to the dock pill (never leave it on a removed overlay). */
  const minimizeTempFocus = useCallback((id: string) => {
    minimizeTemp(id)
    requestAnimationFrame(() => tempPill()?.focus({ preventScroll: true }))
  }, [minimizeTemp])

  return {
    temps, openTemps, openTempCount, tempLayout, isResizing, mainRatio, splitDrag,
    tempDockMounted, hasTemps, dockTemps,
    morphTemp, minimizeTemp, minimizeTempFocus, killTemp, toggleTemp,
    startResize, moveResize, endResize, startSplit, moveSplit, endSplit, splitKeyDown, resizeKeyDown,
  }
}
