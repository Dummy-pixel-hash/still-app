import { useLayoutEffect, useRef } from "react"

/** Stable keyed rows move only when the library's order changes, never per token. */
export function useAgentListMotion(order: string) {
  const root = useRef<HTMLElement>(null)
  const positions = useRef(new Map<string, number>())
  const animations = useRef<Animation[]>([])
  useLayoutEffect(() => {
    animations.current.forEach(animation => animation.cancel())
    animations.current = []
    const parent = root.current
    if (!parent) return
    const next = new Map<string, number>()
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    const top = parent.getBoundingClientRect().top
    const measured = [...parent.querySelectorAll<HTMLElement>("[data-agent-row]")].map(row => ({ row, key: row.dataset.agentRow!, y: row.getBoundingClientRect().top - top + parent.scrollTop }))
    for (const { row, key, y } of measured) {
      next.set(key, y)
      const previous = positions.current.get(key)
      if (!reduced && previous !== undefined && Math.abs(previous - y) > 1) {
        animations.current.push(row.animate([{ transform: `translateY(${previous - y}px)` }, { transform: "translateY(0)" }], { duration: 150, easing: "ease-out" }))
      }
    }
    positions.current = next
    return () => { animations.current.forEach(animation => animation.cancel()) }
  }, [order])
  return root
}
