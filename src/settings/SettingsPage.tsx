import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import type { OrbPublisherState } from "../orb/publisher"
import { trapTab } from "../ui/focusTrap"
import { CATEGORIES, SETTINGS, settingMatches, type CategoryId, type SettingsCtx } from "./registry"

/**
 * Full-page settings: a portalled, full-screen dialog with a vertical tablist
 * on the left (select on narrow screens) and a tabpanel on the right. Search
 * filters every setting and groups the hits by category.
 */
export default function SettingsPage({
  onClose,
  keyTextCache,
  onKeyText,
  orbRuntime,
}: {
  orbRuntime: OrbPublisherState & { retry(): void }
  onClose: () => void
  keyTextCache: Map<string, string>
  onKeyText: (keyId: string, text: string | null) => void
}) {
  const uid = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const opener = useRef<HTMLElement | null>(null)
  const [category, setCategory] = useState<CategoryId>("general")
  const [query, setQuery] = useState("")
  const searching = query.trim().length > 0
  const ctx: SettingsCtx = { orbRuntime, keyTextCache, onKeyText }

  // Focus moves into the page on open and returns to the opener on close.
  // StrictMode runs this effect twice: only the first run sees the opener.
  useEffect(() => {
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null
    tabRefs.current[category]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = useCallback(() => {
    onClose()
    const el = opener.current
    if (el && el.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }))
  }, [onClose])

  const hits = useMemo(() => SETTINGS.filter((s) => settingMatches(s, query)), [query])
  const counts = useMemo(() => {
    const out = {} as Record<CategoryId, number>
    for (const c of CATEGORIES) out[c.id] = hits.filter((h) => h.category === c.id).length
    return out
  }, [hits])

  const selectCategory = (id: CategoryId, focus = false) => {
    setCategory(id)
    if (searching) {
      // While searching every hit is listed; the tab just jumps to its group.
      requestAnimationFrame(() => {
        const group = panelRef.current?.querySelector<HTMLElement>(`[data-group="${id}"]`)
        group?.scrollIntoView({ block: "start" })
        group?.focus({ preventScroll: true })
      })
    }
    if (focus) tabRefs.current[id]?.focus()
  }

  const onTabKey = (e: KeyboardEvent<HTMLElement>) => {
    const ids = CATEGORIES.map((c) => c.id)
    const i = ids.indexOf(category)
    let next = -1
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % ids.length
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i - 1 + ids.length) % ids.length
    else if (e.key === "Home") next = 0
    else if (e.key === "End") next = ids.length - 1
    if (next < 0) return
    e.preventDefault()
    selectCategory(ids[next], true)
  }

  const activeMeta = CATEGORIES.find((c) => c.id === category)!
  const shown = searching ? CATEGORIES.filter((c) => counts[c.id] > 0) : [activeMeta]

  // Portalled: workspace gets pointer-events:none while the overlay is open.
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${uid}-title`}
      data-key-scope="modal"
      className="grain fixed inset-0 z-[60] flex flex-col bg-[#0b0b0e] text-fg"
      onKeyDown={(e) => {
        if (trapTab(e, dialogRef.current)) return
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          // Escape clears the search first, then closes.
          if (query) {
            setQuery("")
            searchRef.current?.focus()
          } else close()
        }
      }}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.07] px-4 py-3 sm:px-6">
        <h1 id={`${uid}-title`} className="font-serif text-3xl text-fg">Settings</h1>
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-3">
          <label htmlFor={`${uid}-search`} className="sr-only">Search settings</label>
          <input
            id={`${uid}-search`}
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            autoComplete="off"
            className="h-9 w-full max-w-xs rounded-full border border-white/10 bg-black/40 px-4 text-[13px] text-fg transition placeholder:text-faint focus:border-[#ff4a4a]/50"
          />
          <button
            type="button"
            onClick={close}
            className="h-9 shrink-0 rounded-full bg-[#e8e2e6] px-5 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
          >
            Close
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {/* Narrow screens: categories collapse into a select. */}
        <div className="border-b border-white/[0.07] px-4 py-3 sm:hidden">
          <label htmlFor={`${uid}-cat`} className="mb-1 block text-xs text-dim">Category</label>
          <select
            id={`${uid}-cat`}
            value={category}
            onChange={(e) => selectCategory(e.target.value as CategoryId)}
            className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-[13px] text-fg"
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id} className="bg-[#121214]">
                {c.label}{searching ? ` (${counts[c.id]})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div
          role="tablist"
          aria-orientation="vertical"
          aria-labelledby={`${uid}-title`}
          className="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-white/[0.07] p-3 sm:flex"
        >
          {CATEGORIES.map((c) => {
            const selected = c.id === category
            return (
              <button
                key={c.id}
                ref={(el) => { tabRefs.current[c.id] = el }}
                id={`${uid}-tab-${c.id}`}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls={`${uid}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectCategory(c.id)}
                onKeyDown={onTabKey}
                className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                  selected ? "bg-white/[0.08] text-fg" : "text-dim hover:bg-white/[0.04] hover:text-fg"
                } ${searching && counts[c.id] === 0 ? "opacity-50" : ""}`}
              >
                <span>{c.label}</span>
                {searching ? (
                  <span className="rounded-full bg-white/[0.08] px-1.5 text-xs text-fg" data-testid={`count-${c.id}`}>
                    {counts[c.id]}
                    <span className="sr-only"> matches</span>
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        <div
          ref={panelRef}
          id={`${uid}-panel`}
          role="tabpanel"
          aria-labelledby={searching ? `${uid}-title` : `${uid}-tab-${category}`}
          tabIndex={-1}
          className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8"
        >
          <div className="mx-auto max-w-3xl">
            {searching && hits.length === 0 ? (
              <p role="status" className="text-[13px] text-dim">No settings match “{query.trim()}”.</p>
            ) : null}
            {searching && hits.length > 0 ? (
              <p role="status" aria-live="polite" className="mb-4 text-xs text-dim">
                {hits.length} {hits.length === 1 ? "setting matches" : "settings match"} “{query.trim()}”
              </p>
            ) : null}
            {shown.map((c) => {
              const defs = searching ? hits.filter((h) => h.category === c.id) : SETTINGS.filter((s) => s.category === c.id)
              return (
                <section key={c.id} data-group={c.id} tabIndex={-1} aria-labelledby={`${uid}-h-${c.id}`} className="mb-8">
                  <h2 id={`${uid}-h-${c.id}`} className="font-serif text-2xl text-fg">{c.label}</h2>
                  <p className="mt-1 text-[13px] text-dim">{c.blurb}</p>
                  <div className="mt-4 flex flex-col">
                    {defs.map((d) => (
                      <div key={d.id} data-setting={d.id}>{d.render(ctx)}</div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
