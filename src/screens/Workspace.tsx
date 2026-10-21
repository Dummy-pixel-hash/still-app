import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import WindowNav from "../components/WindowNav"
import SessionCard from "../components/SessionCard"
import TerminalOverlay, { MORPH_MS, type OpenState } from "../components/TerminalOverlay"
import SessionForm from "../components/SessionForm"
import NewSessionWizard from "../components/NewSessionWizard"
import NewProjectDialog from "../components/NewProjectDialog"
import RemoveProjectDialog from "../components/RemoveProjectDialog"
import RemoveDialog from "../components/RemoveDialog"
import AuthDialog from "../components/AuthDialog"
// Behind a click, and it pulls in the orb renderer + shader source: keep the
// initial bundle to the workspace itself.
const SettingsSheet = lazy(() => import("../components/SettingsSheet"))
import BrowserOrbPreview from "../orb/BrowserOrbPreview"
import { useOrbPublisher } from "../orb/useOrbPublisher"
import {
  createProject,
  createSession,
  moveSession,
  removeProject,
  removeSession,
  touchSession,
  updateSession,
  useStore,
} from "../session/store"
import {
  connectionError,
  connectionState,
  releaseSession,
  useConnections,
} from "../session/connections"
import { nativeBridge } from "../bridge/nativeBridge"
import type { ConnState, Project, Session, SessionDraft } from "../types"

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"

/** Read once per call: the preference does not change mid-transition. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}
type Sort = "manual" | "recent" | "name"

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

// Transient key text cache: memory only, cleared on reload. Lets the
// key-library flow connect without re-pasting within a session.
const keyTextCache = new Map<string, string>()

function minutesAgo(lastOpenedAt?: number): number {
  if (!lastOpenedAt) return Number.MAX_SAFE_INTEGER
  return (Date.now() - lastOpenedAt) / 60000
}

/**
 * Still workspace: spatial project grouping, session cards, search/sort,
 * card-origin terminal morph, session CRUD, settings + key library.
 */
export default function Workspace() {
  const store = useStore()
  useConnections()
  const [sort, setSort] = useState<Sort>("manual")
  const [q, setQ] = useState("")
  const [open, setOpen] = useState<OpenState | null>(null)
  // Temp terminals: arrays of memory-only scratch sessions, each docked in
  // its own overlay beside main. Minimize hides the view (worker +
  // transcript survive). The dock only exists while at least one temp does.
  const [temps, setTemps] = useState<Session[]>([])
  const [openTemps, setOpenTemps] = useState<Record<string, OpenState>>({})
  const [tempDockCollapsed, setTempDockCollapsed] = useState(false)
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
  // Pointer-based card drag (works in the packaged WebView, where native
  // HTML5 DnD never starts, plus mouse + touch in the browser).
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropProject, setDropProject] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const [ghost, setGhost] = useState<{
    x: number
    y: number
    w: number
    name: string
  } | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState<string | null>(null)
  const [showNewProject, setShowNewProject] = useState(false)
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null)
  const [removingProject, setRemovingProject] = useState<Project | null>(null)
  const [editing, setEditing] = useState<Session | null>(null)
  const [removing, setRemoving] = useState<Session | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [authFor, setAuthFor] = useState<{
    session: Session
    mode: "password" | "key"
    resolve: (a: { secret?: string; remember: boolean } | null) => void
  } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeTimer = useRef(0)
  const returnTarget = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Live refs so window-level pointermove/up handlers (attached once per
  // gesture) never read stale render closures.
  const viewRef = useRef<{ project: Project; sessions: Session[] }[]>([])
  const storeRef = useRef(store)
  const sortRef = useRef(sort)
  const qRef = useRef(q)
  const pendingRef = useRef<{
    id: string
    startX: number
    startY: number
    active: boolean
    name: string
    sourceProject: string
    w: number
  } | null>(null)
  const dropRef = useRef<{ project: string | null; before: string | null }>({
    project: null,
    before: null,
  })
  const suppressClickUntil = useRef(0)

  useEffect(
    () => () => {
      window.clearTimeout(closeTimer.current)
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

  const openSession = useCallback((s: Session, el: HTMLElement | null, autoConnect = true) => {
    returnTarget.current = el ?? searchRef.current
    window.clearTimeout(closeTimer.current)
    touchSession(s.id)
    const rect = el?.getBoundingClientRect() ?? new DOMRect(
      window.innerWidth / 2 - Math.min(320, window.innerWidth - 32) / 2,
      Math.max(32, window.innerHeight / 2 - 90), Math.min(320, window.innerWidth - 32), 180,
    )
    setOpen({ session: s, rect, phase: "enter", autoConnect })
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setOpen((o) => (o ? { ...o, phase: "open" } : o)),
      ),
    )
  }, [])

  const authForRef = useRef<typeof authFor>(null)
  authForRef.current = authFor

  const close = useCallback(() => {
    // Cancelling the overlay cancels any pending auth prompt too — otherwise
    // the AuthDialog would linger with no overlay beneath it.
    const pending = authForRef.current
    // Temp owns its own auth lifecycle; closing main never cancels it.
    if (pending && !pending.session.id.startsWith("temp-")) {
      authForRef.current = null
      setAuthFor(null)
      pending.resolve(null)
    }
    setOpen((o) => {
      if (!o || o.phase !== "open") return o
      const el = document.querySelector(`[data-card="${o.session.id}"]`)
      const rect = el ? el.getBoundingClientRect() : o.rect
      return { ...o, rect, phase: "exit" }
    })
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      setOpen(null)
      requestAnimationFrame(() =>
        returnTarget.current?.focus({ preventScroll: true }),
      )
    }, prefersReducedMotion() ? 0 : MORPH_MS + 50)
  }, [])

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
    // A fresh dock should reveal its first row rather than inherit a collapse
    // choice from a previous batch of temps.
    if (!temps.length) setTempDockCollapsed(false)
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
      if (e.repeat) return
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== "t") return
      e.preventDefault()
      e.stopPropagation()
      toggleRef.current()
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [])

  // Global keys: Ctrl/Cmd+K focuses search (workspace only), Ctrl+. or
  // Ctrl+` leaves the terminal. Never intercept while the terminal or any
  // editable field (input/textarea/select) has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      // Close-first: Ctrl+. / Ctrl+` leaves the terminal from anywhere
      // except the xterm surface itself (raw PTY bytes take precedence).
      // Auth/form dialogs must never trap the user in the overlay.
      if (open && e.ctrlKey && (e.key === "." || e.key === "`")) {
        if (target?.closest?.(".xterm") || target?.closest?.("[data-temp-dock]")) return
        e.preventDefault()
        close()
        return
      }
      if (target?.closest?.(".xterm")) return
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !open) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [close, open])

  const needAuth = useCallback((session: Session) => {
    const mode: "password" | "key" =
      session.authMethod === "key" ? "key" : "password"
    return new Promise<{ secret?: string; remember: boolean } | null>(
      (resolve) => {
        setAuthFor({ session, mode, resolve })
      },
    )
  }, [])

  const keyTextFor = useCallback((keyId: string) => keyTextCache.get(keyId) ?? null, [])

  const onNeedAuth = useCallback(
    async (session: Session) => {
      // Silent path: keyring already holds the secret — skip the dialog
      // unless the stored secret just failed auth (then it is wrong).
      // "ask" sessions (the wizard default) save password credentials too,
      // so they must check as well — otherwise Remember persists but is
      // never reused and the dialog appears every time.
      if (session.authMethod === "password" || session.authMethod === "ask") {
        const err = connectionError(session.id) ?? ""
        if (!/auth|wrong|password|incorrect|denied/i.test(err)) {
          try {
            if (
              await nativeBridge.hasCredential(
                session.host,
                session.port,
                session.username,
              )
            ) {
              return { secret: undefined, remember: true }
            }
          } catch {
            // Fall through to the dialog.
          }
        }
      }
      const ans = await needAuth(session)
      setAuthFor(null)
      return ans
    },
    [needAuth],
  )

  const handleCreate = useCallback(
    async (draft: SessionDraft) => {
      // Auth is deferred: create the card, open it, and let the overlay
      // auto-connect prompt via AuthDialog. No secrets ever pass through
      // the creation flow — they stay transient in the connect flow.
      const session = createSession({ ...draft })
      setShowNew(null)
      requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-card="${session.id}"]`,
        ) as HTMLElement | null
        if (el) openSession(session, el)
      })
    },
    [openSession],
  )

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return store.projects
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((p) => {
        const inProject = store.sessions.filter((s) => s.projectId === p.id)
        const orderedIds = store.order[p.id]
        let list = orderedIds
          ? orderedIds
              .map((id) => inProject.find((s) => s.id === id))
              .filter((s): s is Session => Boolean(s))
          : [...inProject]
        // Include sessions missing from the order map (e.g. legacy).
        for (const s of inProject) {
          if (!list.some((l) => l.id === s.id)) list.push(s)
        }
        if (needle)
          list = list.filter((s) =>
            `${s.name} ${s.host} ${s.username}`.toLowerCase().includes(needle),
          )
        if (sort === "recent")
          list = [...list].sort(
            (a, b) => minutesAgo(a.lastOpenedAt) - minutesAgo(b.lastOpenedAt),
          )
        if (sort === "name")
          list = [...list].sort((a, b) => a.name.localeCompare(b.name))
        return { project: p, sessions: list }
      })
  }, [q, sort, store.order, store.projects, store.sessions])

  viewRef.current = view
  storeRef.current = store
  sortRef.current = sort
  qRef.current = q

  const empty = store.sessions.length === 0

  const cancelDrag = useCallback(() => {
    pendingRef.current = null
    dropRef.current = { project: null, before: null }
    setDragId(null)
    setDropProject(null)
    setDropBefore(null)
    setGhost(null)
    document.body.style.userSelect = ""
    document.body.style.cursor = ""
  }, [])

  const commitDrag = useCallback(() => {
    const pending = pendingRef.current
    const drop = dropRef.current
    const wasActive = pending?.active
    const id = pending?.id
    pendingRef.current = null
    dropRef.current = { project: null, before: null }
    setDragId(null)
    setDropProject(null)
    setDropBefore(null)
    setGhost(null)
    document.body.style.userSelect = ""
    document.body.style.cursor = ""
    if (!wasActive || !id) return
    // A real drag just happened: swallow the click that pointerup would
    // otherwise deliver to the card (which opens the terminal).
    suppressClickUntil.current = Date.now() + 300
    if (!drop.project) return
    const st = storeRef.current
    const src = st.sessions.find((s) => s.id === id)
    if (!src) return
    // Sorted / filtered views don't express manual order: same-project
    // drops would be invisible, so treat them as a no-op. Cross-project
    // moves still apply (position follows the target view's sort).
    if (
      drop.project === src.projectId &&
      (sortRef.current !== "manual" || qRef.current.trim() !== "")
    )
      return
    const full: string[] =
      st.order[drop.project] ??
      st.sessions.filter((s) => s.projectId === drop.project).map((s) => s.id)
    const before = drop.before
    if (before && !full.includes(before) && before !== null) {
      moveSession(id, drop.project)
      return
    }
    // Same-position no-op: already immediately before `before` (or already
    // last when appending).
    if (drop.project === src.projectId) {
      const at = full.indexOf(id)
      if (before == null) {
        if (at === full.length - 1) return
      } else if (full[at + 1] === before) {
        return
      }
    }
    moveSession(id, drop.project, before ?? undefined)
  }, [])

  const handleCardPointerDown = useCallback(
    (e: ReactPointerEvent, session: Session, el: HTMLElement) => {
      if (open) return
      if (e.pointerType === "mouse" && e.button !== 0) return
      const target = e.target as HTMLElement | null
      // Touch uses the grip handle so a finger drag never fights scroll;
      // mouse/pen may grab anywhere except interactive controls.
      if (
        e.pointerType === "touch" &&
        !target?.closest?.("[data-drag-handle]")
      )
        return
      setMenuId(null)
      setProjectMenuId(null)
      const rect = el.getBoundingClientRect()
      pendingRef.current = {
        id: session.id,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        name: session.name,
        sourceProject: session.projectId,
        w: Math.max(200, Math.min(340, rect.width)),
      }

      const onMove = (ev: PointerEvent) => {
        const pending = pendingRef.current
        if (!pending) return
        const dx = ev.clientX - pending.startX
        const dy = ev.clientY - pending.startY
        if (!pending.active) {
          if (Math.hypot(dx, dy) < 7) return
          pending.active = true
          setDragId(pending.id)
          document.body.style.userSelect = "none"
          document.body.style.cursor = "grabbing"
        }
        setGhost({
          x: ev.clientX,
          y: ev.clientY,
          w: pending.w,
          name: pending.name,
        })

        // Drop target via hit-testing (works for mouse + touch + pen).
        const under = document.elementFromPoint(
          ev.clientX,
          ev.clientY,
        ) as HTMLElement | null
        const cardEl = under?.closest?.("[data-card]") as HTMLElement | null
        const projEl = under?.closest?.("[data-project]") as HTMLElement | null
        let project: string | null = null
        let before: string | null = null
        if (cardEl) {
          const targetId = cardEl.dataset.card ?? null
          if (targetId && targetId !== pending.id) {
            const group = viewRef.current.find(({ sessions }) =>
              sessions.some((s) => s.id === targetId),
            )
            if (group) {
              project = group.project.id
              const r = cardEl.getBoundingClientRect()
              // Grid-aware half: bottom/right half means "after".
              const after =
                ev.clientY > r.top + r.height / 2 ||
                (Math.abs(ev.clientY - (r.top + r.height / 2)) <
                  r.height * 0.2 &&
                  ev.clientX > r.left + r.width / 2)
              if (after) {
                const idx = group.sessions.findIndex((s) => s.id === targetId)
                before = group.sessions[idx + 1]?.id ?? null
              } else {
                before = targetId
              }
            }
          } else if (targetId === pending.id) {
            // Hovering the dragged card itself: keep its project lit so
            // the user sees where a release would land (appends at end).
            const group = viewRef.current.find(({ sessions }) =>
              sessions.some((s) => s.id === targetId),
            )
            project = group?.project.id ?? pending.sourceProject
            before = null
          }
        }
        if (!project && projEl?.dataset.project) {
          project = projEl.dataset.project
          before = null
        }
        const prev = dropRef.current
        if (prev.project !== project || prev.before !== before) {
          dropRef.current = { project, before }
          setDropProject(project)
          setDropBefore(before)
        }

        // Edge auto-scroll the workspace list.
        const scroller = scrollRef.current
        if (scroller) {
          const sr = scroller.getBoundingClientRect()
          if (ev.clientY < sr.top + 72) scroller.scrollBy(0, -14)
          else if (ev.clientY > sr.bottom - 72) scroller.scrollBy(0, 14)
        }
        if (ev.cancelable) ev.preventDefault()
      }

      const onUp = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        commitDrag()
      }
      const onCancel = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        cancelDrag()
      }
      window.addEventListener("pointermove", onMove, { passive: false })
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
    },
    [cancelDrag, commitDrag, open],
  )

  // Escape cancels an in-flight drag.
  useEffect(() => {
    if (!dragId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDrag()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cancelDrag, dragId])

  const handleCardOpen = useCallback(
    (sess: Session, el: HTMLElement) => {
      if (Date.now() < suppressClickUntil.current) return
      if (pendingRef.current?.active) return
      setMenuId(null)
      openSession(sess, el)
    },
    [openSession],
  )

  // Stable handlers: the card grid is memo()'d, so re-creating these inline
  // would re-render every card on every keystroke in any form field.
  const handleEditCard = useCallback((sess: Session) => {
    setMenuId(null)
    setEditing(sess)
  }, [])

  const handleRemoveCard = useCallback(
    (sess: Session) => {
      setMenuId(null)
      if (storeRef.current.settings.confirmRemove) setRemoving(sess)
      else void releaseSession(sess.id).finally(() => removeSession(sess.id))
    },
    [],
  )

  // Stable identity: a spread here creates a new array every render and
  // defeats the publisher's own change detection (and any memo downstream).
  const orbSessions = useMemo(
    () => [...store.sessions, ...temps],
    [store.sessions, temps],
  )

  const orbRuntime = useOrbPublisher(
    orbSessions,
    authFor?.session.id ?? null,
    store.settings.orb,
    (sessionId) => {
      // Bringing Still forward must never discard a draft or strand an auth promise.
      if (authForRef.current || showSettings || showNew || showNewProject || editing || removing || removingProject) {
        document.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] button')?.focus()
        return
      }
      if (!sessionId) return
      const focusTerminal = () => document.getElementById(`still-term-${sessionId}`)?.querySelector<HTMLTextAreaElement>("textarea")?.focus()
      const temp = temps.find((t) => t.id === sessionId)
      if (temp) {
        if (!openTemps[sessionId] || openTemps[sessionId]?.phase === "exit") morphTemp(temp, document.getElementById("temp-pill"), false)
        else requestAnimationFrame(focusTerminal)
        return
      }
      const session = store.sessions.find(s => s.id === sessionId)
      if (!session) return
      if (open?.session.id === sessionId && open.phase !== "exit") { requestAnimationFrame(focusTerminal); return }
      setQ("")
      const card = document.querySelector<HTMLElement>(`[data-card="${CSS.escape(sessionId)}"]`)
      // No auto-connect here: even a disconnect racing the morph only opens the
      // existing session view. It cannot create another SSH attempt from the orb.
      openSession(session, card, false)
    },
  )

  // Temp dock helpers: aggregate status dot and per-temp label/state.
  const tempAggregateDot = (list: Session[] = temps) => {
    if (!list.length) return "bg-white/30"
    const states = list.map((t) => connectionState(t.id))
    if (states.includes("error")) return "bg-red-400"
    // Neutral while connecting: amber is "needs you" in the orb's own
    // vocabulary, and a starting session is not an alarm.
    if (states.some((s) => s === "connecting")) return "bg-white/40"
    if (states.every((s) => s === "connected")) return "bg-emerald-400"
    return "bg-white/30"
  }

  const tempDotClass = (id: string) =>
    connectionState(id) === "connected"
      ? "bg-emerald-400"
      : connectionState(id) === "connecting"
        ? "bg-white/40"
        : connectionState(id) === "error"
          ? "bg-red-400"
          : "bg-white/30"

  // Plain render helpers (not components): rows keep their React identity
  // across parent re-renders instead of remounting on every keystroke.
  const tempRow = (temp: Session) => {
    const isOpen = Boolean(openTemps[temp.id])
    return (
      <li
        key={temp.id}
        className={`temp-row-in flex items-center gap-2 rounded-md border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.15em] ${isOpen ? "border-amber-300/70 text-still-fg" : "border-white/10 text-still-dim"}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tempDotClass(temp.id)}`} aria-hidden />
        <span className="truncate">{temp.name} · {connectionState(temp.id)}</span>
        <button
          type="button"
          disabled={isOpen}
          onClick={() => morphTemp(temp, document.getElementById("temp-pill"))}
          className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:border-amber-300/50 disabled:opacity-40 disabled:hover:border-white/10"
        >
          Restore
        </button>
        <button
          type="button"
          onClick={() => void killTemp(temp.id)}
          className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:border-[#ff4a4a]/50 hover:text-still-fg"
        >
          Kill
        </button>
      </li>
    )
  }

  const dockCollapseIcon = (
    <svg width="12" height="12" viewBox="0 0 12 12" className="h-3.5 w-3.5" aria-hidden>
      <path d={tempDockCollapsed ? "M3 5l3-3 3 3" : "M3 7l3 3 3-3"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )

  return (
    <div className="grain relative flex h-full flex-col overflow-hidden rounded-lg bg-ink text-fg ring-1 ring-white/10">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 h-96 w-[46rem] -translate-x-1/2 rounded-full opacity-25 blur-3xl"
        style={{
          background: "radial-gradient(closest-side, #b3161c, transparent)",
        }}
      />
      <WindowNav />

      <div
        ref={scrollRef}
        className="relative z-10 min-h-0 flex-1 overflow-y-auto scroll-quiet transition-[transform,opacity] duration-[650ms]"
        style={{
          transitionTimingFunction: EASE,
          transform: open ? "scale(0.965)" : "none",
          // A scrim, not a blur: blurring a layer full of live xterm canvases
          // re-rasterizes every frame and destroys the crisp grid the morph
          // is coming from.
          opacity: open ? 0.35 : 1,
          pointerEvents: open ? "none" : "auto",
        }}
        // Out of the tab order and the a11y tree while the overlay owns the
        // screen. pointerEvents:none alone still lets Tab reach the grid.
        inert={open ? true : undefined}
      >
        <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-16 sm:px-6">
          <section className="rise flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
                Persistent remote terminal
              </p>
              <h1 className="mt-1 font-serif text-4xl leading-tight sm:text-5xl">
                Still <span className="italic text-dim">workspace</span>
              </h1>
            </div>
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 lg:w-auto">
              <div className="relative">
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation()
                      setQ("")
                      e.currentTarget.blur()
                    }
                  }}
                  placeholder="Search sessions…"
                  aria-label="Search sessions"
                  enterKeyHint="search"
                  className="w-44 rounded-full border border-white/10 bg-black/40 py-1.5 pl-3 pr-12 text-[12px] text-fg outline-none transition focus:w-56 focus:border-[#ff4a4a]/50 sm:w-52"
                />
                <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-faint">
                  ⌃K
                </kbd>
              </div>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                aria-label="Sort sessions"
                className="rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-[12px] text-dim outline-none"
              >
                <option value="manual" className="bg-[#121214]">Manual</option>
                <option value="recent" className="bg-[#121214]">Recent</option>
                <option value="name" className="bg-[#121214]">Name</option>
              </select>
              <button
                type="button"
                onClick={() => setShowNewProject(true)}
                className="rounded-full border border-white/10 px-4 py-1.5 text-[13px] text-dim transition hover:border-white/25 hover:text-fg"
              >
                + Project
              </button>
              <button
                type="button"
                onClick={() => {
                  const p = store.projects[0] ?? createProject("Default", "")
                  setShowNew(p.id)
                }}
                className="rounded-full bg-[#e8e2e6] px-4 py-1.5 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
              >
                New Session
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                aria-label="Settings"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 text-dim transition hover:border-white/25 hover:text-fg"
              >
                ⚙
              </button>
            </div>
          </section>

          {empty ? (
            <section className="rise mt-10 rounded-[20px] border border-dashed border-white/15 bg-white/[0.02] p-10 text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
                {store.projects.length === 0 ? "Welcome to Still" : "Workspace is empty"}
              </p>
              <p className="mt-2 font-serif text-3xl text-fg">
                {store.projects.length === 0
                  ? "Connect your first server"
                  : "No sessions yet"}
              </p>
              <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-dim">
                {store.projects.length === 0
                  ? "Still keeps one persistent tmux session per card. Create a session, connect, and authenticate when asked — reopen any time and reattach."
                  : "Create your first persistent session. The remote tmux runtime survives disconnects — come back any time and reattach."}
              </p>
              <button
                type="button"
                onClick={() => {
                  const p =
                    store.projects[0] ?? createProject("Default", "")
                  setShowNew(p.id)
                }}
                className="mt-5 rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
              >
                New Session
              </button>
              <p className="mt-3 font-mono text-[11px] text-faint">
                1. New session → 2. Connect → 3. Sign in when asked
              </p>
            </section>
          ) : (
            view.map(({ project, sessions }) => (
              <section
                key={project.id}
                data-project={project.id}
                className={`mt-8 rounded-[20px] p-2 transition-shadow ${
                  dragId && dropProject === project.id
                    ? "shadow-[0_0_0_1px_rgba(255,74,74,0.45),0_0_40px_-12px_rgba(255,74,74,0.35)]"
                    : "shadow-[0_0_0_1px_transparent]"
                }`}
              >
                <header className="mb-3 flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-serif text-2xl text-fg">
                      {project.name}
                    </h2>
                    {project.note ? (
                      <p className="truncate font-mono text-[11px] text-faint">
                        {project.note}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-faint">
                      {sessions.length}
                    </span>
                    <button
                      type="button"
                      aria-label={`New session in ${project.name}`}
                      onClick={() => setShowNew(project.id)}
                      className="flex h-6 w-6 items-center justify-center rounded-full border border-white/10 font-mono text-[14px] text-dim transition hover:border-[#ff4a4a]/50 hover:text-fg"
                    >
                      +
                    </button>
                    <span className="relative">
                      <button
                        type="button"
                        aria-label={`Actions for project ${project.name}`}
                        aria-expanded={projectMenuId === project.id}
                        onClick={() =>
                          setProjectMenuId(
                            projectMenuId === project.id ? null : project.id,
                          )
                        }
                        className="rounded-md px-2 py-1 font-mono text-[13px] leading-none text-faint transition hover:bg-white/[0.07] hover:text-fg"
                      >
                        •••
                      </button>
                      {projectMenuId === project.id ? (
                        <span className="absolute right-0 top-7 z-20 flex w-44 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#121214]/95 py-1 text-[12px] shadow-[0_16px_40px_rgba(0,0,0,0.7)] backdrop-blur-xl">
                          <button
                            type="button"
                            onClick={() => {
                              setProjectMenuId(null)
                              setRemovingProject(project)
                            }}
                            className="px-3 py-1.5 text-left text-[#ff8080] transition hover:bg-white/[0.07]"
                          >
                            Remove project…
                          </button>
                        </span>
                      ) : null}
                    </span>
                  </div>
                </header>
                {sessions.length === 0 ? (
                  <p
                    className={`rounded-2xl border border-dashed px-4 py-6 text-center text-[12px] transition ${
                      dragId && dropProject === project.id
                        ? "border-[#ff4a4a]/60 bg-[#ff4a4a]/[0.06] text-fg"
                        : "border-white/10 text-faint"
                    }`}
                  >
                    {/* Distinguish an empty project from a filtered one: a
                        no-match search used to invite creating a duplicate. */}
                    {q.trim() && !empty
                      ? `No sessions match “${q.trim()}”.`
                      : "Drag a card here, or press + to create one."}
                  </p>
                ) : (
                  <div
                    data-card-grid
                    className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                  >
                    {sessions.map((s, i) => (
                      <Fragment key={s.id}>
                        {dragId &&
                        dropProject === project.id &&
                        dropBefore === s.id ? (
                          <div
                            data-drop-indicator
                            aria-hidden
                            className="col-span-full h-[3px] rounded-full bg-[#ff4a4a]/80 shadow-[0_0_16px_rgba(255,74,74,0.6)]"
                          />
                        ) : null}
                        <SessionCard
                          session={s}
                          conn={
                            connectionState(s.id) === "disconnected" &&
                            !s.lastOpenedAt
                              ? "never"
                              : connectionState(s.id)
                          }
                          index={i}
                          fontSize={store.settings.terminal.fontSize}
                          dragging={dragId === s.id}
                          dropHighlight={
                            dropProject === project.id &&
                            dropBefore === s.id
                          }
                          menuOpen={menuId === s.id}
                          onOpen={handleCardOpen}
                          onEdit={handleEditCard}
                          onRemove={handleRemoveCard}
                          onToggleMenu={setMenuId}
                          onCardPointerDown={handleCardPointerDown}
                        />
                      </Fragment>
                    ))}
                    {dragId &&
                    dropProject === project.id &&
                    (dropBefore == null ||
                      !sessions.some((s) => s.id === dropBefore)) ? (
                      <div
                        data-drop-indicator
                        aria-hidden
                        className="col-span-full h-[3px] rounded-full bg-[#ff4a4a]/80 shadow-[0_0_16px_rgba(255,74,74,0.6)]"
                      />
                    ) : null}
                  </div>
                )}
              </section>
            ))
          )}
        </main>
      </div>

      <TerminalOverlay
        open={open}
        prefs={store.settings.terminal}
        imageInsertStyle={store.settings.imageInsertStyle ?? "path"}
        keyTextFor={keyTextFor}
        onClose={close}
        onNeedAuth={onNeedAuth}
        slot={Object.keys(openTemps).length > 0 ? "left" : undefined}
        dockStyle={
          openTempCount === 1
            ? { top: 0, left: 0, height: "100vh", width: `calc(${mainRatio * 100}vw)` }
            : undefined
        }
      />

      {tempLayout.map((item) => (
        <TerminalOverlay
          key={item.id}
          open={openTemps[item.id]}
          prefs={store.settings.terminal}
          imageInsertStyle={store.settings.imageInsertStyle ?? "path"}
          keyTextFor={keyTextFor}
          onClose={() => minimizeTemp(item.id)}
          onNeedAuth={onNeedAuth}
          dockStyle={{
            ...(openTempCount === 1
              ? { top: 0, height: "100vh", left: `calc(${mainRatio * 100}vw + 1px)`, width: `calc(${(1 - mainRatio) * 100}vw - 1px)` }
              : { top: item.top, height: item.height, left: "calc(50vw + 1px)", width: "calc(50vw - 1px)" }),
            // Direct manipulation: never let the 650ms open/close morph lag
            // behind the pointer or re-animate the final commit.
            transition: (isResizing || splitDrag.current) ? "none" : undefined,
          }}
          slot="right"
        />
      ))}

      {tempLayout.slice(0, -1).map((item, i) => {
        const bottom = tempLayout[i + 1]
        const pairHeight = item.height + bottom.height
        return (
          <div
            key={`resize-${item.id}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize temp terminals"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              pairHeight > 0 ? Math.round((item.height / pairHeight) * 100) : 50
            }
            data-temp-dock
            tabIndex={0}
            title="Drag to resize · arrow keys fine-tune"
            onPointerDown={startResize(item.id, bottom.id)}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onLostPointerCapture={endResize}
            onKeyDown={resizeKeyDown(item.id, bottom.id)}
            className="group fixed z-[65] flex touch-none select-none items-center justify-center outline-none"
            style={{
              top: bottom.top - 4,
              left: "calc(50vw + 1px)",
              width: "calc(50vw - 1px)",
              height: 8,
              cursor: "ns-resize",
              // Follow the same open/close redistribution as the tiles, but
              // stay glued to the pointer while the user is dragging.
              transition: isResizing
                ? "none"
                : `top ${MORPH_MS}ms ${EASE}`,
            }}
          >
            <span
              aria-hidden
              className={`pointer-events-none h-[2px] rounded-full transition-[width,background-color] duration-150 ${
                isResizing
                  ? "w-12 bg-amber-300/80"
                  : "w-7 bg-white/15 group-hover:w-11 group-hover:bg-amber-300/70 group-focus-visible:w-11 group-focus-visible:bg-amber-300/70"
              }`}
            />
          </div>
        )
      })}
      {openTempCount === 1 && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize terminal"
          aria-valuemin={30}
          aria-valuemax={80}
          aria-valuenow={Math.round(mainRatio * 100)}
          data-temp-dock
          tabIndex={0}
          title="Drag to resize · arrow keys fine-tune"
          onPointerDown={startSplit}
          onPointerMove={moveSplit}
          onPointerUp={endSplit}
          onPointerCancel={endSplit}
          onKeyDown={splitKeyDown}
          className="group fixed z-[65] flex touch-none select-none items-center justify-center outline-none"
          style={{
            top: 0,
            left: `calc(${mainRatio * 100}vw - 4px)`,
            width: 8,
            height: "100vh",
            cursor: "ew-resize",
            transition: (isResizing || splitDrag.current) ? "none" : undefined,
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none h-full w-[2px] rounded-full transition-[width,background-color] duration-150 bg-white/10 group-hover:w-3 group-hover:bg-amber-300/70 group-focus-visible:w-3 group-focus-visible:bg-amber-300/70"
          />
        </div>
      )}


      {tempDockMounted && (
        <div
          id="temp-pill"
          data-temp-dock
          role="group"
          aria-label="Temp terminals"
          aria-hidden={hasTemps ? undefined : true}
          inert={hasTemps ? undefined : true}
          className={`temp-dock-peek ${hasTemps ? "temp-dock-in" : "temp-dock-out"}`}
        >
          <span className="temp-dock-peek__rest" aria-hidden>
            <span className={`h-1.5 w-1.5 rounded-full temp-dock__dot ${tempAggregateDot(dockTemps)}`} />
          </span>
          <div className="temp-dock-peek__reveal">
            {dockTemps.length > 0 && (
              <ul className="temp-dock-peek__list">{dockTemps.map((t) => tempRow(t))}</ul>
            )}
            <button type="button" className="temp-dock-peek__add" onClick={toggleTemp}>
              + New
            </button>
          </div>
        </div>
      )}

      {showNew ? (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="New session"
          onClick={() => setShowNew(null)}
        >
          <div
            className="grain relative max-h-[92vh] w-full max-w-xl overflow-y-auto scroll-quiet rounded-t-[20px] border border-white/10 bg-[#0b0b0e] p-6 sm:rounded-[20px]"
            onClick={(e) => e.stopPropagation()}
          >
            <NewSessionWizard
              key={showNew}
              initialProjectId={showNew}
              projects={store.projects}
              onCreateProject={(name) => createProject(name)}
              onSubmit={(draft) => void handleCreate(draft)}
              onCancel={() => setShowNew(null)}
            />
          </div>
        </div>
      ) : null}

      {showNewProject ? (
        <NewProjectDialog onClose={() => setShowNewProject(false)} />
      ) : null}

      {editing ? (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${editing.name}`}
          onClick={() => setEditing(null)}
        >
          <div
            className="grain relative max-h-[92vh] w-full max-w-xl overflow-y-auto scroll-quiet rounded-t-[20px] border border-white/10 bg-[#0b0b0e] p-6 sm:rounded-[20px]"
            onClick={(e) => e.stopPropagation()}
          >
            <SessionForm
              heading="Edit session"
              submitLabel="Save"
              initial={editing}
              keyOptions={store.keys}
              onCancel={() => setEditing(null)}
              onSubmit={(draft) => {
                // Metadata only — never auto-connects, tmux identity kept.
                updateSession(editing.id, {
                  name: draft.name.trim(),
                  host: draft.host.trim(),
                  port: Number.parseInt(draft.port, 10) || 22,
                  username: draft.username.trim(),
                  projectId: draft.projectId,
                  workingDirectory: draft.workingDirectory.trim() || "~",
                  authMethod: draft.authMethod,
                  keyId:
                    draft.authMethod === "key" ? draft.keyId || undefined : undefined,
                  remember: draft.remember,
                })
                setEditing(null)
              }}
            />
          </div>
        </div>
      ) : null}

      {removing ? (
        <RemoveDialog session={removing} onClose={() => setRemoving(null)} />
      ) : null}

      {removingProject ? (
        <RemoveProjectDialog
          projectName={removingProject.name}
          sessionCount={
            store.sessions.filter((s) => s.projectId === removingProject.id).length
          }
          onClose={() => setRemovingProject(null)}
          onConfirm={() => {
            const gone = removeProject(removingProject.id)
            setRemovingProject(null)
            // Drop live workers for the removed cards; remote tmux survives.
            void Promise.all(gone.map((s) => releaseSession(s.id)))
          }}
        />
      ) : null}

      {nativeBridge.isDevelopmentAdapter ? <BrowserOrbPreview /> : null}

      {showSettings ? (
        <Suspense fallback={null}>
          <SettingsSheet
            orbRuntime={orbRuntime}
            onClose={() => setShowSettings(false)}
            keyTextCache={keyTextCache}
            onKeyText={(id, text) => {
              if (text) keyTextCache.set(id, text)
              else keyTextCache.delete(id)
            }}
          />
        </Suspense>
      ) : null}

      {authFor ? (
        <AuthDialog
          session={authFor.session}
          mode={authFor.mode}
          onResolve={authFor.resolve}
        />
      ) : null}

      {ghost && dragId ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[80] -translate-x-1/2 -translate-y-1/2 rotate-2 rounded-2xl border border-[#ff4a4a]/40 bg-[#141416]/95 px-4 py-3 shadow-[0_24px_60px_rgba(0,0,0,0.8),0_0_32px_-8px_rgba(255,74,74,0.5)] backdrop-blur-xl"
          style={{ left: ghost.x, top: ghost.y, width: ghost.w }}
        >
          <p className="truncate text-[14px] font-medium text-fg">
            {ghost.name}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-faint">
            {dropProject
              ? `→ ${
                  viewRef.current.find((v) => v.project.id === dropProject)
                    ?.project.name ?? "project"
                }`
              : "drag to a project"}
          </p>
        </div>
      ) : null}
    </div>
  )
}
