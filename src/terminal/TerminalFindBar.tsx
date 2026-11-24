import { useEffect, useId, useRef, useState } from "react"
import type { Terminal } from "@xterm/xterm"
import { SearchAddon } from "@xterm/addon-search"

const DECORATIONS = {
  matchBackground: "#4a4130",
  matchOverviewRuler: "#d5aa82",
  activeMatchBackground: "#8f2a2a",
  activeMatchBorder: "#ff5a5a",
  activeMatchColorOverviewRuler: "#ff5a5a",
}

/**
 * In-terminal scrollback search (Ctrl+Shift+F). Previous/Next, an "n of m"
 * status, Escape to close. The overlay's key gate ignores [data-terminal-find]
 * so typing here never reaches the PTY or triggers terminal shortcuts.
 */
export default function TerminalFindBar({ terminal, onClose }: { terminal: Terminal; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const addonRef = useRef<SearchAddon | null>(null)
  const [term, setTerm] = useState(() => {
    const sel = terminal.getSelection()
    return sel && !sel.includes("\n") && sel.length < 200 ? sel : ""
  })
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)
  const id = useId()

  useEffect(() => {
    const addon = new SearchAddon()
    terminal.loadAddon(addon)
    addonRef.current = addon
    const sub = addon.onDidChangeResults((r) => setResult({ index: r.resultIndex, count: r.resultCount }))
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      sub.dispose()
      try {
        addon.clearDecorations()
        addon.dispose()
      } catch {
        // Terminal already torn down.
      }
      addonRef.current = null
    }
  }, [terminal])

  const options = { caseSensitive, decorations: DECORATIONS }
  // Incremental search while typing; empty input clears the highlights.
  useEffect(() => {
    const addon = addonRef.current
    if (!addon) return
    if (!term) {
      addon.clearDecorations()
      setResult(null)
      return
    }
    const found = addon.findNext(term, { ...options, incremental: true })
    if (!found) setResult({ index: -1, count: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, caseSensitive])

  const step = (dir: 1 | -1) => {
    const addon = addonRef.current
    if (!addon || !term) return
    const found = dir === 1 ? addon.findNext(term, options) : addon.findPrevious(term, options)
    if (!found) setResult({ index: -1, count: 0 })
  }

  let status = ""
  if (term) {
    if (!result || result.count === 0) status = "No results"
    else if (result.index < 0) status = `${result.count}+ results`
    else status = `${result.index + 1} of ${result.count}`
  }

  const btn =
    "rounded-md bg-white/[0.08] px-2.5 py-1 text-xs text-fg transition hover:bg-white/[0.14] disabled:opacity-40"
  return (
    <div
      data-terminal-find
      role="search"
      aria-labelledby={`${id}-label`}
      className="absolute right-6 top-2 z-30 flex items-center gap-2 rounded-xl border border-white/10 bg-[#121214]/95 py-1.5 pl-3 pr-2 text-xs text-fg shadow-[0_16px_40px_rgba(0,0,0,0.7)] backdrop-blur-xl"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <label id={`${id}-label`} htmlFor={`${id}-input`} className="text-dim">
        Find
      </label>
      <input
        ref={inputRef}
        id={`${id}-input`}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }
        }}
        autoComplete="off"
        spellCheck={false}
        className="w-44 rounded-md border border-white/10 bg-black/50 px-2 py-1 font-mono text-xs text-fg"
      />
      <span role="status" aria-live="polite" data-testid="find-status" className="min-w-[4.5rem] text-dim">
        {status}
      </span>
      <button type="button" className={btn} onClick={() => step(-1)} disabled={!term}>
        Previous
      </button>
      <button type="button" className={btn} onClick={() => step(1)} disabled={!term}>
        Next
      </button>
      <label className="flex items-center gap-1 text-dim">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} className="accent-[#ff4a4a]" />
        Match case
      </label>
      <button type="button" className={btn} onClick={onClose}>
        Close
      </button>
    </div>
  )
}
