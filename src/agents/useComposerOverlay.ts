import { useLayoutEffect, useRef } from "react"

/** Reserve exactly the floating dock's height so the last message stays above
 * the input as drafts, notices, and narrow-screen controls change its size. */
export function useComposerOverlay(active: boolean) {
  const dock = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = dock.current, chat = element?.closest<HTMLElement>(".agent-chat")
    if (!active || !element || !chat) return
    let frame = 0, height = -1
    const measure = () => {
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
    return () => { observer.disconnect(); cancelAnimationFrame(frame); chat.style.removeProperty("--ag-composer-height") }
  }, [active])
  return dock
}
