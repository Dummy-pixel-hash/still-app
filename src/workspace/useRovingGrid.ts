import { useCallback, useState, type KeyboardEvent } from "react"

/**
 * Roving focus across the card grid. One card open button is the Tab stop;
 * arrows move across/between rows, Home/End jump within the project,
 * Ctrl+Up/Down hop projects, Shift+F10 (or the Menu key) opens the card menu.
 */
export function useRovingGrid({ onOpenMenu }: { onOpenMenu: (id: string) => void }) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const t = e.target as HTMLElement
      if (!t.matches?.("[data-card-open]")) return
      const card = t.closest<HTMLElement>("[data-card]")
      const id = card?.dataset.card
      if (!card || !id) return
      if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
        e.preventDefault()
        onOpenMenu(id)
        return
      }
      const project = card.closest<HTMLElement>("[data-project]")
      const inProject = Array.from(project?.querySelectorAll<HTMLElement>("[data-card-open]") ?? [])
      const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-card-open]"))
      const i = inProject.indexOf(t)
      let next: HTMLElement | undefined
      const mid = (el: HTMLElement) => {
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      if (e.ctrlKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const projects = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-project]")).filter((p) => p.querySelector("[data-card-open]"))
        const pi = projects.indexOf(project as HTMLElement)
        const target = projects[pi + (e.key === "ArrowDown" ? 1 : -1)]
        next = target?.querySelector<HTMLElement>("[data-card-open]") ?? undefined
      } else if (e.ctrlKey || e.metaKey || e.altKey) {
        return
      } else if (e.key === "ArrowRight") next = inProject[i + 1] ?? all[all.indexOf(t) + 1]
      else if (e.key === "ArrowLeft") next = inProject[i - 1] ?? all[all.indexOf(t) - 1]
      else if (e.key === "Home") next = inProject[0]
      else if (e.key === "End") next = inProject[inProject.length - 1]
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const here = mid(t)
        const dir = e.key === "ArrowDown" ? 1 : -1
        // Nearest card in the adjacent row (by vertical then horizontal distance).
        let best: { el: HTMLElement; d: number } | undefined
        for (const el of all) {
          const m = mid(el)
          const dy = (m.y - here.y) * dir
          if (dy < 20) continue
          const d = dy * 4 + Math.abs(m.x - here.x)
          if (!best || d < best.d) best = { el, d }
        }
        next = best?.el
      } else return
      e.preventDefault()
      if (next) {
        next.focus()
        next.scrollIntoView({ block: "nearest" })
      }
    },
    [onOpenMenu],
  )
  return { activeId, setActiveId, onKeyDown }
}
