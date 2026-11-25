import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import WindowNav from "../components/WindowNav"
import { agentConnectionId } from "../agents/workspace"
import { useAgentStorageError } from "../session/agentStorage"
const RemoteAgentWorkspace = lazy(() => import("../components/RemoteAgentWorkspace"))

import TerminalOverlay, { MORPH_MS, type OpenState } from "../components/TerminalOverlay"
import AuthDialog from "../components/AuthDialog"
// Behind a click, and it pulls in the orb renderer + shader source: keep the
// initial bundle to the workspace itself.
const SettingsPage = lazy(() => import("../settings/SettingsPage"))
import BrowserOrbPreview from "../orb/BrowserOrbPreview"
import { useOrbPublisher } from "../orb/useOrbPublisher"
import {
  createProject,
  createSession,
  moveSession,
  removeSession,
  reorderSession,
  setSessionAppearance,
  touchSession,
  useStore,
} from "../session/store"
import {
  connectionError,
  connectionState,
  releaseSession,
  useConnections,
} from "../session/connections"
import { nativeBridge } from "../bridge/nativeBridge"
import { PRESET_THEMES } from "../terminal/appearance"
import { useMediaPrefs } from "../terminal/useTerminalAppearance"
import ShortcutHelp from "../ui/ShortcutHelp"
import type { Project, Session, SessionDraft } from "../types"
import CommandPalette from "../workspace/CommandPalette"
import EmptyState from "../workspace/EmptyState"
import ProjectSection from "../workspace/ProjectSection"
import TempDock from "../workspace/TempDock"
import WorkspaceDialogs from "../workspace/WorkspaceDialogs"
import WorkspaceHeader, { type Sort } from "../workspace/WorkspaceHeader"
import type { CardHandlers } from "../workspace/cardHandlers"
import { cardEl, cardOpenButton, tempPill } from "../workspace/focusTargets"
import { prefersReducedMotion } from "../workspace/motion"
import type { PaletteCommand } from "../workspace/paletteCommands"
import { useCardDrag } from "../workspace/useCardDrag"
import { useRovingGrid } from "../workspace/useRovingGrid"
import { useTempDock, EASE, type AuthState } from "../workspace/useTempDock"
import { useWorkspaceKeys } from "../workspace/useWorkspaceKeys"

// Transient key text cache: memory only, cleared on reload. Lets the
// key-library flow connect without re-pasting within a session.
const keyTextCache = new Map<string, string>()

function minutesAgo(lastOpenedAt?: number): number {
  if (!lastOpenedAt) return Number.MAX_SAFE_INTEGER
  return (Date.now() - lastOpenedAt) / 60000
}

/**
 * Still workspace coordinator: owns open/close, auth and the dialogs' state;
 * the card drag, temp dock, header, project sections and palette live in
 * src/workspace/.
 */
export default function Workspace() {
  const store = useStore()
  useConnections()
  const mediaEnv = useMediaPrefs()
  const [sort, setSort] = useState<Sort>("manual")
  const [q, setQ] = useState("")
  const [open, setOpen] = useState<OpenState | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState<string | null>(null)
  const [showNewProject, setShowNewProject] = useState(false)
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null)
  const [removingProject, setRemovingProject] = useState<Project | null>(null)
  const [editing, setEditing] = useState<Session | null>(null)
  const [removing, setRemoving] = useState<Session | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // Command palette: `sessionId` is the session Appearance commands apply to.
  const [paletteFor, setPaletteFor] = useState<{ sessionId: string | null } | null>(null)
  const [agentFor, setAgentFor] = useState<Session | null>(null)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [agentsClosing, setAgentsClosing] = useState(false)
  const agentsCloseTimer = useRef(0)
  const agentSaveError = useAgentStorageError()

  const [authFor, setAuthFor] = useState<AuthState | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeTimer = useRef(0)
  const returnTarget = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const authForRef = useRef<typeof authFor>(null)
  authForRef.current = authFor
  // Live refs so window-level handlers never read stale render closures.
  const viewRef = useRef<{ project: Project; sessions: Session[] }[]>([])
  const storeRef = useRef(store)
  const sortRef = useRef<string>(sort)
  const qRef = useRef(q)

  const dock = useTempDock({ open, sessions: store.sessions, authForRef, setAuthFor, agentsOpen })

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const openSession = useCallback((s: Session, el: HTMLElement | null, autoConnect = true) => {
    // Focus returns to the card's Open button however the open was started
    // (card click, menu Open, Agents, the orb). Geometry comes from the card.
    returnTarget.current = cardOpenButton(s.id) ?? el ?? searchRef.current
    window.clearTimeout(closeTimer.current)
    touchSession(s.id)
    const source = cardEl(s.id) ?? el
    const rect = source?.getBoundingClientRect() ?? new DOMRect(
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

  // Global keys: Ctrl+. or Ctrl+` leaves the terminal.
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
        const err = `${connectionError(session.id) || ""} ${connectionError(agentConnectionId(session)) || ""}`
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

  const filtering = q.trim()
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

  viewRef.current = view
  storeRef.current = store
  sortRef.current = sort
  qRef.current = q

  const empty = store.sessions.length === 0

  const drag = useCardDrag({
    open,
    storeRef,
    viewRef,
    sortRef,
    qRef,
    scrollRef,
    onDragStart: useCallback(() => {
      setMenuId(null)
      setProjectMenuId(null)
    }, []),
  })

  const handleCardOpen = useCallback(
    (sess: Session, el: HTMLElement) => {
      if (drag.shouldSuppressClick()) return
      setMenuId(null)
      openSession(sess, el)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openSession, drag.shouldSuppressClick],
  )

  const handleStartAgentFromCard = useCallback((session: Session) => {
    setMenuId(null)
    window.clearTimeout(agentsCloseTimer.current)
    setAgentsClosing(false)
    setAgentFor(session)
    setAgentsOpen(true)
  }, [])

  const closeAgents = useCallback(() => {
    if (agentsClosing) return
    const pending = authForRef.current
    if (pending && agentsOpen) {
      authForRef.current = null
      setAuthFor(null)
      pending.resolve(null)
    }
    setAgentsClosing(true)
    agentsCloseTimer.current = window.setTimeout(() => {
      setAgentFor(null)
      setAgentsOpen(false)
      setAgentsClosing(false)
    }, prefersReducedMotion() ? 0 : 150)
  }, [agentsClosing, agentsOpen])

  const handleEditCard = useCallback((sess: Session) => {
    setMenuId(null)
    setEditing(sess)
  }, [])

  const handleRemoveCard = useCallback((sess: Session) => {
    setMenuId(null)
    if (storeRef.current.settings.confirmRemove) setRemoving(sess)
    else void releaseSession(sess.id).finally(() => removeSession(sess.id))
  }, [])

  // Keyboard alternatives to dragging a card.
  const handleMove = useCallback((sess: Session, direction: -1 | 1) => {
    const group = viewRef.current.find((g) => g.project.id === sess.projectId)
    if (!group) return
    const ids = group.sessions.map((s) => s.id)
    const at = ids.indexOf(sess.id)
    const to = at + direction
    if (at < 0 || to < 0 || to >= ids.length) return
    ;[ids[at], ids[to]] = [ids[to], ids[at]]
    reorderSession(sess.id, sess.projectId, ids)
  }, [])
  const handleMoveToProject = useCallback((sess: Session, projectId: string) => {
    moveSession(sess.id, projectId)
  }, [])

  const rover = useRovingGrid({ onOpenMenu: setMenuId })
  const firstId = view.find((g) => g.sessions.length)?.sessions[0]?.id ?? null
  const tabStopId =
    rover.activeId && store.sessions.some((s) => s.id === rover.activeId) && view.some((g) => g.sessions.some((s) => s.id === rover.activeId))
      ? rover.activeId
      : firstId

  const cardHandlers: CardHandlers = useMemo(
    () => ({
      onOpen: handleCardOpen,
      onOpenAgent: handleStartAgentFromCard,
      onEdit: handleEditCard,
      onRemove: handleRemoveCard,
      onToggleMenu: setMenuId,
      onCardPointerDown: drag.handleCardPointerDown,
      onMove: handleMove,
      onMoveToProject: handleMoveToProject,
      onCardFocus: rover.setActiveId,
    }),
    [handleCardOpen, handleStartAgentFromCard, handleEditCard, handleRemoveCard, drag.handleCardPointerDown, handleMove, handleMoveToProject, rover.setActiveId],
  )

  // Stable identity: a spread here creates a new array every render and
  // defeats the publisher's own change detection (and any memo downstream).
  const orbSessions = useMemo(
    () => [...store.sessions, ...dock.temps],
    [store.sessions, dock.temps],
  )

  const orbRuntime = useOrbPublisher(
    orbSessions,
    authFor?.session.id ?? null,
    store.settings.orb,
    (sessionId) => {
      // Bringing Still forward must never discard a draft or strand an auth promise.
      if (authForRef.current || showSettings || helpOpen || paletteFor || showNew || showNewProject || editing || removing || removingProject) {
        document.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] button')?.focus()
        return
      }
      if (!sessionId) return
      const focusTerminal = () => document.getElementById(`still-term-${sessionId}`)?.querySelector<HTMLTextAreaElement>("textarea")?.focus()
      const temp = dock.temps.find((t) => t.id === sessionId)
      if (temp) {
        if (!dock.openTemps[sessionId] || dock.openTemps[sessionId]?.phase === "exit") dock.morphTemp(temp, tempPill(), false)
        else requestAnimationFrame(focusTerminal)
        return
      }
      const session = store.sessions.find(s => s.id === sessionId)
      if (!session) return
      if (open?.session.id === sessionId && open.phase !== "exit") { requestAnimationFrame(focusTerminal); return }
      setQ("")
      const card = cardOpenButton(sessionId)
      // No auto-connect here: even a disconnect racing the morph only opens the
      // existing session view. It cannot create another SSH attempt from the orb.
      openSession(session, card, false)
    },
  )

  // --- command palette -----------------------------------------------------
  const openPalette = useCallback(
    (sessionId?: string | null) => {
      const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("[data-card]")?.dataset.card
      setPaletteFor({ sessionId: sessionId ?? open?.session.id ?? focused ?? null })
    },
    [open],
  )
  const openAgents = useCallback(() => {
    window.clearTimeout(agentsCloseTimer.current)
    setAgentsClosing(false)
    setAgentFor(null)
    setAgentsOpen(true)
  }, [])
  const newSessionInFirst = useCallback(() => {
    const p = storeRef.current.projects[0] ?? createProject("Default", "")
    setShowNew(p.id)
  }, [])

  useWorkspaceKeys({
    blocked: Boolean(showSettings || helpOpen || paletteFor || showNew || showNewProject || editing || removing || removingProject || agentsOpen || authFor),
    terminalOpen: Boolean(open),
    searchRef,
    onPalette: () => openPalette(null),
    onHelp: () => setHelpOpen(true),
    onToggleAgents: () => {
      if (agentsClosing) {
        window.clearTimeout(agentsCloseTimer.current)
        setAgentsClosing(false)
      } else if (agentsOpen) closeAgents()
      else openAgents()
    },
  })

  const paletteSession = paletteFor?.sessionId
    ? store.sessions.find((s) => s.id === paletteFor.sessionId) ?? dock.temps.find((t) => t.id === paletteFor.sessionId) ?? null
    : null

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [...store.sessions].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)).map((s) => ({
      id: `session-${s.id}`,
      group: "Sessions",
      label: s.name,
      hint: s.host ? `${s.username}@${s.host}` : undefined,
      keywords: `open jump ${s.username}`,
      run: () => {
        setQ("")
        openSession(s, cardOpenButton(s.id))
      },
    }))
    list.push(
      { id: "new-session", group: "Actions", label: "New session", hint: "", run: newSessionInFirst },
      { id: "new-project", group: "Actions", label: "New project", run: () => setShowNewProject(true) },
      { id: "settings", group: "Actions", label: "Settings", run: () => setShowSettings(true) },
      { id: "agents", group: "Actions", label: "Agents", hint: "Ctrl+Shift+A", run: openAgents },
      { id: "shortcuts", group: "Actions", label: "Keyboard shortcuts", hint: "Ctrl+Shift+/", run: () => setHelpOpen(true) },
      { id: "temp", group: "Actions", label: "New temp terminal", hint: "Ctrl+Shift+T", run: dock.toggleTemp },
      ...(["manual", "recent", "name"] as const).map((value) => ({
        id: `sort-${value}`, group: "View" as const, label: `Sort: ${value[0].toUpperCase()}${value.slice(1)}`,
        hint: sort === value ? "current" : undefined, run: () => setSort(value),
      })),
      { id: "filter", group: "View", label: "Filter sessions", hint: "/", run: () => requestAnimationFrame(() => searchRef.current?.focus()) },
    )
    if (paletteSession) {
      const sid = paletteSession.id
      for (const t of [...PRESET_THEMES, ...store.settings.customThemes])
        list.push({ id: `theme-${t.id}`, group: "Appearance", label: `Theme: ${t.name}`, keywords: "colour color palette", run: () => setSessionAppearance(sid, { terminalTheme: t.id }) })
      list.push(
        { id: "theme-default", group: "Appearance", label: "Use the default theme", run: () => setSessionAppearance(sid, { terminalTheme: undefined }) },
        { id: "font-reset", group: "Appearance", label: "Reset font size", keywords: "zoom text", run: () => setSessionAppearance(sid, { fontSize: undefined }) },
      )
    }
    return list
  }, [store.sessions, store.settings.customThemes, paletteSession, openSession, newSessionInFirst, openAgents, dock.toggleTemp, sort])

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
        <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-20 sm:px-6" onKeyDown={rover.onKeyDown}>
          <WorkspaceHeader
            q={q}
            setQ={setQ}
            sort={sort}
            setSort={setSort}
            searchRef={searchRef}
            onPalette={() => openPalette(null)}
            onAgents={openAgents}
            onSettings={() => setShowSettings(true)}
            onNewSession={newSessionInFirst}
          />

          {empty ? (
            <EmptyState hasProjects={store.projects.length > 0} onNewSession={newSessionInFirst} />
          ) : (
            view.map(({ project, sessions }) => (
              <ProjectSection
                key={project.id}
                project={project}
                sessions={sessions}
                projects={store.projects}
                store={store}
                env={mediaEnv}
                filtering={filtering}
                canReorder={sort === "manual" && !filtering}
                dragId={drag.dragId}
                dropProject={drag.dropProject}
                dropBefore={drag.dropBefore}
                menuId={menuId}
                tabStopId={tabStopId}
                projectMenuOpen={projectMenuId === project.id}
                onProjectMenu={(o) => setProjectMenuId(o ? project.id : null)}
                onNewSession={setShowNew}
                onRemoveProject={setRemovingProject}
                handlers={cardHandlers}
              />
            ))
          )}
        </main>
      </div>

      <TerminalOverlay
        open={open}
        imageInsertStyle={store.settings.imageInsertStyle ?? "path"}
        keyTextFor={keyTextFor}
        onClose={close}
        onNeedAuth={onNeedAuth}
        onOpenPalette={openPalette}
        slot={dock.openTempCount > 0 ? "left" : undefined}
        dockStyle={
          dock.openTempCount === 1
            ? { top: 0, left: 0, height: "100vh", width: `calc(${dock.mainRatio * 100}vw)` }
            : undefined
        }
      />

      <TempDock
        dock={dock}
        imageInsertStyle={store.settings.imageInsertStyle ?? "path"}
        keyTextFor={keyTextFor}
        onNeedAuth={onNeedAuth}
        onOpenPalette={openPalette}
      />

      <WorkspaceDialogs
        projects={store.projects}
        sessions={store.sessions}
        keys={store.keys}
        showNew={showNew}
        setShowNew={setShowNew}
        showNewProject={showNewProject}
        setShowNewProject={setShowNewProject}
        editing={editing}
        setEditing={setEditing}
        removing={removing}
        setRemoving={setRemoving}
        removingProject={removingProject}
        setRemovingProject={setRemovingProject}
        onCreate={handleCreate}
      />

      {nativeBridge.isDevelopmentAdapter ? <BrowserOrbPreview /> : null}

      {showSettings ? (
        <Suspense fallback={null}>
          <SettingsPage
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

      {paletteFor ? (
        <CommandPalette
          commands={commands}
          contextLabel={paletteSession?.name}
          onClose={() => setPaletteFor(null)}
        />
      ) : null}
      {helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null}

      {!agentsOpen && agentSaveError && <div className="fixed bottom-5 left-1/2 z-[64] flex max-w-[90vw] -translate-x-1/2 items-center gap-4 rounded-lg bg-[#363226] px-4 py-3 text-[13px] text-[#e9d6b0]" role="alert"><span>Agent history needs attention: {agentSaveError}</span><button className="shrink-0 underline" onClick={openAgents}>Open conversations</button></div>}
      {agentsOpen ? <Suspense fallback={<div className="fixed inset-0 z-[65] flex items-center justify-center bg-[#151517] text-[14px] text-[#a4a4ae]" role="status">Opening conversations…</div>}><RemoteAgentWorkspace closing={agentsClosing} session={agentFor} sessions={store.sessions} onNeedAuth={onNeedAuth} keyTextFor={keyTextFor} onClose={closeAgents}
        onOpenTerminal={target => { closeAgents(); openSession(target, cardOpenButton(target.id)) }} /></Suspense> : null}

      {authFor ? (
        <AuthDialog
          session={authFor.session}
          mode={authFor.mode}
          purpose={agentsOpen ? "agent" : "terminal"}
          onResolve={authFor.resolve}
        />
      ) : null}

      {drag.ghost && drag.dragId ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[80] -translate-x-1/2 -translate-y-1/2 rotate-2 rounded-2xl border border-white/25 bg-[#141416]/95 px-4 py-3 shadow-[0_24px_60px_rgba(0,0,0,0.8),0_0_32px_-8px_rgba(255,255,255,0.18)] backdrop-blur-xl"
          style={{ left: drag.ghost.x, top: drag.ghost.y, width: drag.ghost.w }}
        >
          <p className="truncate text-[14px] font-medium text-fg">{drag.ghost.name}</p>
          <p className="mt-0.5 font-mono text-xs text-faint">
            {drag.dropProject
              ? `→ ${viewRef.current.find((v) => v.project.id === drag.dropProject)?.project.name ?? "project"}`
              : "drag to a project"}
          </p>
        </div>
      ) : null}
    </div>
  )
}
