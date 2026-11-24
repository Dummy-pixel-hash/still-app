import { useCallback, useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { moveSession } from "../session/store"
import type { Project, Session } from "../types"
import type { OpenState } from "../components/TerminalOverlay"

type StoreLike = { sessions: Session[]; order: Record<string, string[]> }

/**
 * Pointer-based card drag (works in the packaged WebView, where native HTML5
 * DnD never starts, plus mouse + touch in the browser). Pure extraction from
 * Workspace: behaviour is unchanged. Keyboard users reorder via the card menu.
 */
export function useCardDrag({
  open,
  storeRef,
  viewRef,
  sortRef,
  qRef,
  scrollRef,
  onDragStart,
}: {
  open: OpenState | null
  storeRef: MutableRefObject<StoreLike>
  viewRef: MutableRefObject<{ project: Project; sessions: Session[] }[]>
  sortRef: MutableRefObject<string>
  qRef: MutableRefObject<string>
  scrollRef: RefObject<HTMLDivElement | null>
  onDragStart: () => void
}) {
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
      onDragStart()
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
    [cancelDrag, commitDrag, open, onDragStart, scrollRef, viewRef],
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


  /** True while a drag (or the click it would produce) must not open a card. */
  const shouldSuppressClick = () => Date.now() < suppressClickUntil.current || Boolean(pendingRef.current?.active)

  return { dragId, dropProject, dropBefore, ghost, handleCardPointerDown, shouldSuppressClick }
}
