import type { Session } from "../types"

/** A quick row of the five most recently opened sessions. */
export default function RecentSessions({
  sessions,
  onOpen,
}: {
  sessions: Session[]
  onOpen: (s: Session, el: HTMLElement) => void
}) {
  const recent = sessions
    .filter((s) => s.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
    .slice(0, 5)
  if (recent.length === 0) return null
  return (
    <section aria-labelledby="recent-heading" className="mt-5">
      <h2 id="recent-heading" className="text-xs font-medium uppercase tracking-[0.16em] text-faint">Recent</h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {recent.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={(e) => onOpen(s, e.currentTarget)}
              className="flex max-w-[16rem] items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[13px] text-dim transition hover:border-white/25 hover:text-fg"
            >
              <span className="truncate text-fg">{s.name}</span>
              <span className="truncate font-mono text-xs text-faint">{s.host}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
