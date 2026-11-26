import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { groupedShortcuts } from "./shortcuts"

/** Dialog listing every shortcut, generated from the registry. */
export default function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    // StrictMode runs this twice; only the first run sees the real opener.
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
  }, [])
  // Hand focus back to wherever it came from (usually the terminal) on close.
  const close = () => {
    onClose()
    const el = opener.current
    if (el && el.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }))
  }
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      data-key-scope="modal"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="grain relative max-h-[86vh] w-full max-w-lg overflow-y-auto scroll-quiet rounded-[20px] border border-white/10 bg-[#0b0b0e] p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="shortcut-help-title" className="font-serif text-2xl text-fg">Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" onClick={close} className="rounded-full bg-white/[0.08] px-4 py-1.5 text-[13px] text-fg hover:bg-white/[0.14]">
            Close
          </button>
        </div>
        <p className="mt-2 text-[13px] text-dim">
          Inside a terminal, Ctrl+K and Ctrl+/ stay with your shell, so app shortcuts there use Ctrl+Shift or F6.
        </p>
        {groupedShortcuts().map(({ group, items }) => (
          <section key={group} className="mt-5" aria-labelledby={`shortcut-group-${group.replace(/\W/g, "")}`}>
            <h3 id={`shortcut-group-${group.replace(/\W/g, "")}`} className="font-mono text-xs uppercase tracking-[0.18em] text-faint">{group}</h3>
            <dl className="mt-2 divide-y divide-white/[0.06]">
              {items.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-4 py-2">
                  <dt className="text-[13px] text-dim">{s.label}</dt>
                  <dd><kbd className="rounded-md border border-white/10 bg-black/40 px-2 py-0.5 font-mono text-xs text-fg">{s.keys}</kbd></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  )
}
