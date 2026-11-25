import { useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { trapTab } from "../ui/focusTrap"
import { filterCommands, type PaletteCommand, type PaletteGroup } from "./paletteCommands"

/**
 * Command palette: combobox + listbox with aria-activedescendant, so focus
 * stays in the input while the arrow keys move the highlighted option.
 */
export default function CommandPalette({
  commands,
  contextLabel,
  onClose,
}: {
  commands: PaletteCommand[]
  /** e.g. the session Appearance commands apply to. */
  contextLabel?: string
  onClose: () => void
}) {
  const uid = useId()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null
  }, [])
  const results = useMemo(() => filterCommands(commands, query), [commands, query])
  const index = Math.min(active, Math.max(0, results.length - 1))
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[id="${uid}-o-${index}"]`)?.scrollIntoView({ block: "nearest" })
  }, [index, uid])

  const close = () => {
    onClose()
    const el = opener.current
    if (el && el.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }))
  }
  const run = (c: PaletteCommand | undefined) => {
    if (!c) return
    onClose()
    // Commands that open something take focus themselves; others return it.
    requestAnimationFrame(() => c.run())
  }

  const groups: { group: PaletteGroup; items: { c: PaletteCommand; i: number }[] }[] = []
  results.forEach((c, i) => {
    let g = groups.find((x) => x.group === c.group)
    if (!g) groups.push((g = { group: c.group, items: [] }))
    g.items.push({ c, i })
  })

  const glyph = (c: PaletteCommand) => {
    if (c.group === "Sessions") return "•"
    if (c.group === "Appearance") return "◐"
    if (c.group === "View") return c.id.includes("filter") ? "⌕" : "☰"
    if (c.id.includes("new") || c.id === "temp") return "+"
    if (c.id === "settings") return "⚙"
    if (c.id === "shortcuts") return "⌨"
    if (c.id === "agents") return "◇"
    return "›"
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-sm"
      data-key-scope="modal"
      onClick={close}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="w-full max-w-xl overflow-hidden rounded-[20px] border border-white/10 bg-gradient-to-b from-[#141416] to-[#0b0b0c] shadow-[0_24px_60px_rgba(0,0,0,0.8)] motion-safe:animate-[palette-in_160ms_cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (trapTab(e, dialogRef.current)) return
          if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key === "ArrowDown") {
            e.preventDefault()
            setActive((index + 1) % Math.max(1, results.length))
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            setActive((index - 1 + results.length) % Math.max(1, results.length))
          } else if (e.key === "Home") {
            e.preventDefault()
            setActive(0)
          } else if (e.key === "End") {
            e.preventDefault()
            setActive(Math.max(0, results.length - 1))
          } else if (e.key === "Enter") {
            e.preventDefault()
            run(results[index])
          }
        }}
      >
        <h2 id={`${uid}-title`} className="sr-only">Command palette</h2>
        <label htmlFor={`${uid}-input`} className="sr-only">Type a command or session name</label>
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 focus-within:border-white/40">
          <span aria-hidden="true" className="text-xl leading-none text-dim">⌕</span>
          <input
            id={`${uid}-input`}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? `${uid}-o-${index}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or session name…"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-4 text-[14px] text-fg !outline-none placeholder:text-faint"
          />
          <kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-dim">Esc</kbd>
        </div>
        {contextLabel ? <p className="px-4 pt-2 text-xs text-faint">Appearance applies to {contextLabel}</p> : null}
        <div ref={listRef} id={`${uid}-list`} role="listbox" aria-label="Commands" className="scroll-quiet max-h-[50vh] overflow-y-auto py-2">
          {groups.map((g) => (
            <div key={g.group} role="group" aria-labelledby={`${uid}-g-${g.group}`}>
              <p id={`${uid}-g-${g.group}`} className="sticky top-0 z-10 bg-[#111113] px-4 pb-1 pt-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">{g.group}</p>
              {g.items.map(({ c, i }) => (
                <div
                  key={c.id}
                  id={`${uid}-o-${i}`}
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                  className={`flex cursor-pointer items-center gap-3 border-l-2 py-2 pl-3.5 pr-4 text-[13px] ${i === index ? "border-white/70 bg-white/[0.07] text-fg" : "border-transparent text-dim"}`}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <span aria-hidden="true" className="order-first w-4 shrink-0 text-center text-sm text-dim">{glyph(c)}</span>
                  {c.hint ? <kbd className="max-w-[45%] shrink-0 truncate rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-dim">{c.hint}</kbd> : null}
                </div>
              ))}
            </div>
          ))}
          {results.length === 0 ? (
            <p role="status" className="break-words px-4 py-6 text-center text-[13px] text-dim">No commands match "{query}"</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-white/[0.08] px-4 py-3 font-mono text-[10px] text-dim">
          <span>↑↓ navigate · ↵ run · esc close</span>
          <span>{results.length} {results.length === 1 ? "result" : "results"}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
