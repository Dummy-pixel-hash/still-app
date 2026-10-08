import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  reorderSession,
  touchSession,
  updateSession,
  useStore,
} from "../session/store"
import {
  connectionState,
  releaseSession,
  useConnections,
} from "../session/connections"
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
  const [drag, setDrag] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
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
    if (pending) {
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

  const empty = store.sessions.length === 0

  return (
    <div className="grain relative flex h-full flex-col overflow-hidden bg-ink text-fg">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 h-96 w-[46rem] -translate-x-1/2 rounded-full opacity-25 blur-3xl"
        style={{
          background: "radial-gradient(closest-side, #b3161c, transparent)",
        }}
      />
      <WindowNav />

      <div
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
                className={`mt-8 rounded-[20px] transition-shadow ${
                  drag && dragOver === project.id
                    ? "shadow-[0_0_0_1px_rgba(255,74,74,0.45),0_0_40px_-12px_rgba(255,74,74,0.35)]"
                    : "shadow-[0_0_0_1px_transparent]"
                }`}
                onDragOver={(e) => e.preventDefault()}
                onDragEnter={(e) => {
                  e.preventDefault()
                  setDragOver(project.id)
                }}
                onDragLeave={(e) => {
                  // Child-to-child moves bubble with the child as target;
                  // only clear when the pointer truly leaves this section.
                  if (e.target === e.currentTarget) setDragOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(null)
                  if (drag) moveSession(drag, project.id)
                }}
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
                  <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-[12px] text-faint">
                    Drag a card here, or press + to create one.
                  </p>
                ) : (
                  <div
                    className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                  >
                    {sessions.map((s, i) => (
                      <SessionCard
                        key={s.id}
                        session={s}
                        conn={
                          connectionState(s.id) === "disconnected" &&
                          !s.lastOpenedAt
                            ? "never"
                            : connectionState(s.id)
                        }
                        index={i}
                        dragging={drag === s.id}
                        menuOpen={menuId === s.id}
                        onOpen={(sess, el) => {
                          setMenuId(null)
                          openSession(sess, el)
                        }}
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
                        onDragStart={() => setDrag(s.id)}
                        onDragEnd={() => {
                          setDrag(null)
                          setDragOver(null)
                        }}
                        onDropOn={() => {
                          if (drag && drag !== s.id) {
                            const ids = sessions
                              .map((x) => x.id)
                              .filter((id) => id !== drag)
                            const at = ids.indexOf(s.id)
                            ids.splice(at < 0 ? ids.length : at, 0, drag)
                            reorderSession(drag, project.id, ids)
                            moveSession(drag, project.id, s.id)
                            setDrag(null)
                          }
                        }}
                      />
                    ))}
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
        keyTextFor={keyTextFor}
        onClose={close}
        onNeedAuth={onNeedAuth}
      />

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
    </div>
  )
}
