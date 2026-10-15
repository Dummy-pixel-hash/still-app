import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import WindowNav from "../components/WindowNav"
import SessionCard from "../components/SessionCard"
import TerminalOverlay, { type OpenState } from "../components/TerminalOverlay"
import SessionForm from "../components/SessionForm"
import NewSessionWizard from "../components/NewSessionWizard"
import NewProjectDialog from "../components/NewProjectDialog"
import RemoveProjectDialog from "../components/RemoveProjectDialog"
import SettingsSheet from "../components/SettingsSheet"
import RemoveDialog from "../components/RemoveDialog"
import AuthDialog from "../components/AuthDialog"
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
type Sort = "manual" | "recent" | "name"

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
  // Temp terminal: memory-only scratch session in its own overlay docked
  // beside main. Minimize hides the view (worker + transcript survive).
  const [temp, setTemp] = useState<Session | null>(null)
  const [tempOpen, setTempOpen] = useState<OpenState | null>(null)

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

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const openSession = useCallback((s: Session, el: HTMLElement) => {
    returnTarget.current = el
    window.clearTimeout(closeTimer.current)
    touchSession(s.id)
    const rect = el.getBoundingClientRect()
    setOpen({ session: s, rect, phase: "enter" })
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
    }, 700)
  }, [])

  // Center/pill-origin morph for the temp overlay (it has no card).
  const morphTemp = (s: Session, el: HTMLElement | null) => {
    const rect =
      el?.getBoundingClientRect() ??
      new DOMRect(window.innerWidth / 2 - 360, window.innerHeight - 200, 720, 120)
    setTempOpen({ session: s, rect, phase: "enter" })
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setTempOpen((o) => (o && o.session.id === s.id ? { ...o, phase: "open" } : o)),
      ),
    )
  }

  const minimizeTemp = useCallback(() => {
    const pending = authForRef.current
    if (pending && pending.session.id.startsWith("temp-")) {
      authForRef.current = null
      setAuthFor(null)
      pending.resolve(null)
    }
    setTempOpen(null) // instant hide; worker + transcript survive
  }, [])

  const killTemp = useCallback(() => {
    if (!temp) return
    minimizeTemp() // cancels temp-scoped auth, hides view
    const id = temp.id
    setTemp(null)
    void releaseSession(id)
  }, [temp, minimizeTemp])

  const toggleTemp = useCallback(() => {
    if (tempOpen) {
      minimizeTemp()
      return
    }
    if (temp) {
      morphTemp(temp, document.getElementById("temp-pill"))
      return
    }
    if (authForRef.current) return // main dialog up; retry after it resolves
    const src =
      open?.session ??
      [...store.sessions].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0]
    if (!src) return
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const s: Session = {
      ...src,
      id: `temp-${stamp}`,
      name: `Temp ${src.name}`,
      projectId: "",
      tmuxSession: `still-tmp-${stamp.replace(/[^A-Za-z0-9_-]/g, "")}`,
      remember: false,
    }
    setTemp(s)
    morphTemp(s, null)
  }, [open, temp, tempOpen, store.sessions, minimizeTemp])

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
        if (target?.closest?.(".xterm")) return
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
        className="relative z-10 min-h-0 flex-1 overflow-y-auto scroll-quiet transition-all duration-[650ms]"
        style={{
          transitionTimingFunction: EASE,
          transform: open ? "scale(0.965)" : "none",
          filter: open ? "blur(6px) brightness(0.55)" : "none",
          pointerEvents: open ? "none" : "auto",
        }}
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
            <div className="flex items-center gap-2">
              <div className="relative">
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search sessions…"
                  aria-label="Search sessions"
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
                    Drag a card here, or press + to create one.
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
                          onEdit={(sess) => {
                            setMenuId(null)
                            setEditing(sess)
                          }}
                          onRemove={(sess) => {
                            setMenuId(null)
                            if (store.settings.confirmRemove)
                              setRemoving(sess)
                            else {
                              void releaseSession(sess.id).finally(() =>
                                removeSession(sess.id),
                              )
                            }
                          }}
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
        slot={tempOpen ? "left" : undefined}
      />

      {tempOpen ? (
        <TerminalOverlay
          open={tempOpen}
          prefs={store.settings.terminal}
          imageInsertStyle={store.settings.imageInsertStyle ?? "path"}
          keyTextFor={keyTextFor}
          onClose={minimizeTemp}
          onNeedAuth={onNeedAuth}
          slot="right"
        />
      ) : null}

      {temp && !tempOpen ? (
        <div
          id="temp-pill"
          className="fixed bottom-5 right-5 z-[70] flex items-center gap-2.5 rounded-full border border-amber-300/30 bg-black/70 py-2 pl-3 pr-2 shadow-[0_2px_16px_rgba(0,0,0,0.5)] backdrop-blur"
        >
          <span
            aria-hidden
            className={`h-2 w-2 rounded-full ${connectionState(temp.id) === "connected" ? "bg-emerald-400" : connectionState(temp.id) === "connecting" ? "bg-amber-300" : connectionState(temp.id) === "error" ? "bg-red-400" : "bg-white/30"}`}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-still-dim">
            Temp · {connectionState(temp.id)}
          </span>
          <button
            type="button"
            onClick={toggleTemp}
            className="rounded-full border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-still-fg transition-colors hover:border-amber-300/50"
          >
            Restore
          </button>
          <button
            type="button"
            onClick={() => void killTemp()}
            className="rounded-full border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-still-dim transition-colors hover:border-[#ff4a4a]/50 hover:text-still-fg"
          >
            Kill
          </button>
        </div>
      ) : null}

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

      {showSettings ? (
        <SettingsSheet
          onClose={() => setShowSettings(false)}
          keyTextCache={keyTextCache}
          onKeyText={(id, text) => {
            if (text) keyTextCache.set(id, text)
            else keyTextCache.delete(id)
          }}
        />
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
