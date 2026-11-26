import { useEffect, useRef, type RefObject } from "react"
import { matchTerminalShortcut } from "../ui/shortcuts"

/**
 * Workspace-level keys: Ctrl/Cmd+K opens the command palette, `/` focuses the
 * filter, Ctrl+Shift+/ opens shortcut help, Ctrl+Shift+A toggles Agents.
 * Nothing here fires while a terminal, an editable field (except the filter
 * box for the palette) or any modal owns the keyboard.
 */
export function useWorkspaceKeys({
  blocked,
  terminalOpen,
  searchRef,
  onPalette,
  onHelp,
  onToggleAgents,
}: {
  blocked: boolean
  terminalOpen: boolean
  searchRef: RefObject<HTMLInputElement | null>
  onPalette: () => void
  onHelp: () => void
  onToggleAgents: () => void
}) {
  const live = useRef({ blocked, terminalOpen, onPalette, onHelp })
  live.current = { blocked, terminalOpen, onPalette, onHelp }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.(".xterm")) return
      const l = live.current
      if (l.blocked || l.terminalOpen) return
      const tag = target?.tagName
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        if (inField && target !== searchRef.current) return
        e.preventDefault()
        l.onPalette()
        return
      }
      if (inField) return
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (matchTerminalShortcut(e) === "help") {
        e.preventDefault()
        l.onHelp()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [searchRef])

  // Agents toggle (capture: never leaks into a focused terminal or composer).
  const toggle = useRef(onToggleAgents)
  toggle.current = onToggleAgents
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== "a") return
      e.preventDefault()
      e.stopPropagation()
      toggle.current()
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [])
}
