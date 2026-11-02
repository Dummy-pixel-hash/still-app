import { useLayoutEffect, useRef, useState } from "react"

/** Reserve the dock's height and use the actual chat height to move expanded
 * Todos out of the writing rail when a short window cannot fit both. */
export function useComposerOverlay(active: boolean) {
  const dock = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const element = dock.current, chat = element?.closest<HTMLElement>(".agent-chat")
    if (!active || !element || !chat) return
    let frame = 0, height = -1
    const measure = () => {
      setCompact(chat.clientHeight <= 560)
      const next = element.offsetHeight
      if (height === next) return
      height = next
      chat.style.setProperty("--ag-composer-height", `${height}px`)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() })
    })
    observer.observe(element)
    observer.observe(chat)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); chat.style.removeProperty("--ag-composer-height") }
  }, [active])
  return { dock, compact }
}
