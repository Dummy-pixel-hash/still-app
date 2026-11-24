import { Fragment } from "react"
import SessionCard from "../components/SessionCard"
import Menu, { useMenuButton } from "../ui/Menu"
import { connectionError, connectionState } from "../session/connections"
import { resolveSessionAppearance } from "../terminal/useTerminalAppearance"
import type { AppearanceEnv } from "../terminal/appearance"
import type { Project, Session } from "../types"
import type { CardHandlers } from "./cardHandlers"

type StoreView = Parameters<typeof resolveSessionAppearance>[0]

/** One project: heading, actions menu and its grid of cards. */
export default function ProjectSection({
  project,
  sessions,
  projects,
  store,
  env,
  filtering,
  canReorder,
  dragId,
  dropProject,
  dropBefore,
  menuId,
  tabStopId,
  projectMenuOpen,
  onProjectMenu,
  onNewSession,
  onRemoveProject,
  handlers,
}: {
  project: Project
  sessions: Session[]
  projects: Project[]
  store: StoreView
  env: AppearanceEnv
  filtering: string
  canReorder: boolean
  dragId: string | null
  dropProject: string | null
  dropBefore: string | null
  menuId: string | null
  tabStopId: string | null
  projectMenuOpen: boolean
  onProjectMenu: (open: boolean) => void
  onNewSession: (projectId: string) => void
  onRemoveProject: (p: Project) => void
  handlers: CardHandlers
}) {
  const menu = useMenuButton({ open: projectMenuOpen, onOpenChange: onProjectMenu })
  const lit = Boolean(dragId) && dropProject === project.id
  return (
    <section
      data-project={project.id}
      aria-labelledby={`project-${project.id}`}
      className={`mt-7 rounded-[20px] p-2 transition-shadow ${
        lit ? "shadow-[0_0_0_1px_rgba(255,74,74,0.45),0_0_40px_-12px_rgba(255,74,74,0.35)]" : "shadow-[0_0_0_1px_transparent]"
      }`}
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`project-${project.id}`} className="truncate font-serif text-2xl text-fg">{project.name}</h2>
          {project.note ? <p className="truncate font-mono text-xs text-faint">{project.note}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-xs text-faint">
            {sessions.length}
            <span className="sr-only"> sessions</span>
          </span>
          <button
            type="button"
            aria-label={`New session in ${project.name}`}
            onClick={() => onNewSession(project.id)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 font-mono text-[14px] text-dim transition hover:border-[#ff4a4a]/50 hover:text-fg"
          >
            +
          </button>
          <span className="relative">
            <button
              ref={menu.ref}
              type="button"
              aria-label={`Actions for project ${project.name}`}
              {...menu.props}
              className="rounded-md px-2 py-1 font-mono text-[13px] leading-none text-faint transition hover:bg-white/[0.07] hover:text-fg"
            >
              •••
            </button>
            {projectMenuOpen ? (
              <Menu
                id={menu.menuId}
                label={`${project.name} actions`}
                anchorRef={menu.ref}
                onClose={() => onProjectMenu(false)}
                className="right-0 top-8 w-44"
                items={[{ id: "remove", label: "Remove project…", danger: true, onSelect: () => onRemoveProject(project) }]}
              />
            ) : null}
          </span>
        </div>
      </header>
      {sessions.length === 0 ? (
        <p
          className={`rounded-2xl border border-dashed px-4 py-6 text-center text-[13px] transition ${
            lit ? "border-[#ff4a4a]/60 bg-[#ff4a4a]/[0.06] text-fg" : "border-white/10 text-faint"
          }`}
        >
          {/* Distinguish an empty project from a filtered one: a no-match
              search used to invite creating a duplicate. */}
          {filtering ? `No sessions match “${filtering}”.` : "Drag a card here, or press + to create one."}
        </p>
      ) : (
        <div data-card-grid className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s, i) => {
            const conn = connectionState(s.id)
            return (
              <Fragment key={s.id}>
                {lit && dropBefore === s.id ? (
                  <div data-drop-indicator aria-hidden className="col-span-full h-[3px] rounded-full bg-[#ff4a4a]/80 shadow-[0_0_16px_rgba(255,74,74,0.6)]" />
                ) : null}
                <SessionCard
                  session={s}
                  conn={conn === "disconnected" && !s.lastOpenedAt ? "never" : conn}
                  index={i}
                  appearance={resolveSessionAppearance(store, s.id, env)}
                  dragging={dragId === s.id}
                  dropHighlight={dropProject === project.id && dropBefore === s.id}
                  menuOpen={menuId === s.id}
                  tabStop={tabStopId === s.id}
                  errorText={conn === "error" ? (connectionError(s.id) ?? "Connection failed") : undefined}
                  projects={projects}
                  canReorder={canReorder}
                  isFirst={i === 0}
                  isLast={i === sessions.length - 1}
                  onOpen={handlers.onOpen}
                  onOpenAgent={handlers.onOpenAgent}
                  onEdit={handlers.onEdit}
                  onRemove={handlers.onRemove}
                  onToggleMenu={handlers.onToggleMenu}
                  onCardPointerDown={handlers.onCardPointerDown}
                  onMove={handlers.onMove}
                  onMoveToProject={handlers.onMoveToProject}
                  onCardFocus={handlers.onCardFocus}
                />
              </Fragment>
            )
          })}
          {lit && (dropBefore == null || !sessions.some((s) => s.id === dropBefore)) ? (
            <div data-drop-indicator aria-hidden className="col-span-full h-[3px] rounded-full bg-[#ff4a4a]/80 shadow-[0_0_16px_rgba(255,74,74,0.6)]" />
          ) : null}
        </div>
      )}
    </section>
  )
}
