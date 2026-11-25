import type { RefObject } from "react"
import { isTerminalPreview } from "../preview/mode"

export type Sort = "manual" | "recent" | "name"

/** One tight row: brand, palette trigger, filter, sort, actions. */
export default function WorkspaceHeader({
  q,
  setQ,
  sort,
  setSort,
  searchRef,
  onPalette,
  onAgents,
  onSettings,
  onNewProject,
  onNewSession,
}: {
  q: string
  setQ: (q: string) => void
  sort: Sort
  setSort: (s: Sort) => void
  searchRef: RefObject<HTMLInputElement | null>
  onPalette: () => void
  onAgents: () => void
  onSettings: () => void
  onNewProject: () => void
  onNewSession: () => void
}) {
  const pill = "h-9 rounded-full border border-white/10 px-3.5 text-[13px] text-dim transition hover:border-white/25 hover:text-fg"
  return (
    <header className="rise">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="mr-2 min-w-0">
          <h1 className="font-serif text-3xl leading-none">
            Still <span className="italic text-dim">workspace</span>
          </h1>
          {isTerminalPreview() ? <p className="mt-1 font-mono text-xs text-faint">Terminal preview · local simulation</p> : null}
        </div>
        <button type="button" onClick={onPalette} className={pill}>
          Commands
        </button>
        <div className="relative min-w-[11rem] flex-1 md:max-w-sm">
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
            placeholder="Filter sessions…"
            aria-label="Search sessions"
            enterKeyHint="search"
            className="h-9 w-full rounded-full border border-white/10 bg-black/40 pl-4 pr-9 text-[13px] text-fg transition placeholder:text-faint focus:border-white/30"
          />
          <kbd aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-faint">/</kbd>
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort sessions"
          className="h-9 rounded-full border border-white/10 bg-black/40 px-3 text-[13px] text-dim transition hover:text-fg focus:border-white/30"
        >
          <option value="manual" className="bg-[#121214]">Manual</option>
          <option value="recent" className="bg-[#121214]">Recent</option>
          <option value="name" className="bg-[#121214]">Name</option>
        </select>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" title="Open your projects and conversations" onClick={onAgents} className={pill}>Agents</button>
          <button type="button" onClick={onSettings} aria-label="Settings" className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-dim transition hover:border-white/25 hover:text-fg">
            <span aria-hidden>⚙</span>
          </button>
          <button type="button" onClick={onNewProject} className={pill}>+ Project</button>
          <button type="button" onClick={onNewSession} className="h-9 rounded-full bg-[#e8e2e6] px-4 text-[13px] font-medium text-[#17171a] transition hover:bg-white">
            New Session
          </button>
        </div>
      </div>
    </header>
  )
}
