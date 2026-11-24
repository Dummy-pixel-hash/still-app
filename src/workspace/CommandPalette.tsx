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
        className="grain w-full max-w-xl overflow-hidden rounded-[16px] border border-white/10 bg-[#0b0b0e] shadow-[0_24px_60px_rgba(0,0,0,0.8)]"
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
          className="w-full border-b border-white/[0.08] bg-transparent px-4 py-3.5 text-[14px] text-fg placeholder:text-faint"
        />
        {contextLabel ? <p className="px-4 pt-2 text-xs text-faint">Appearance applies to {contextLabel}</p> : null}
        <div ref={listRef} id={`${uid}-list`} role="listbox" aria-label="Commands" className="scroll-quiet max-h-[50vh] overflow-y-auto py-2">
          {groups.map((g) => (
            <div key={g.group} role="group" aria-labelledby={`${uid}-g-${g.group}`}>
              <p id={`${uid}-g-${g.group}`} className="px-4 pb-1 pt-2 text-xs font-medium uppercase tracking-[0.14em] text-faint">{g.group}</p>
              {g.items.map(({ c, i }) => (
                <div
                  key={c.id}
                  id={`${uid}-o-${i}`}
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-[13px] ${i === index ? "bg-white/[0.08] text-fg" : "text-dim"}`}
                >
                  <span className="truncate">{c.label}</span>
                  {c.hint ? <span className="shrink-0 font-mono text-xs text-faint">{c.hint}</span> : null}
                </div>
              ))}
            </div>
          ))}
          {results.length === 0 ? (
            <p role="status" className="px-4 py-6 text-center text-[13px] text-dim">No matching commands.</p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}
