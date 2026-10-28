import { useLayoutEffect, type RefObject } from "react"

/** Keep composer popovers reachable when the writing area consumes a short window. */
export function useAgentPopover(ref: RefObject<HTMLDivElement | null>, open: boolean, align: "start" | "end" = "start") {
  useLayoutEffect(() => {
    const popup = ref.current
    if (!open || !popup) return
    const parent = popup.offsetParent as HTMLElement | null
    if (!parent) return
    const chat = parent.closest<HTMLElement>(".agent-chat")

    const place = () => {
      const viewport = window.visualViewport
      const bounds = chat?.getBoundingClientRect()
      const topEdge = Math.max((viewport?.offsetTop || 0) + 12, bounds ? bounds.top + 8 : 0)
      const leftEdge = Math.max((viewport?.offsetLeft || 0) + 12, bounds ? bounds.left + 8 : 0)
      const bottomEdge = Math.min((viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - 12, bounds ? bounds.bottom - 8 : innerHeight)
      const rightEdge = Math.min((viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - 12, bounds ? bounds.right - 8 : innerWidth)
      const height = Math.max(0, bottomEdge - topEdge)
      const width = Math.max(0, rightEdge - leftEdge)
      const anchor = parent.getBoundingClientRect()
      const above = anchor.top - topEdge - 9
      popup.style.maxHeight = `${Math.max(0, above >= 180 ? Math.min(above, height) : height)}px`
      popup.style.maxWidth = `${Math.max(0, width)}px`
      const top = Math.max(topEdge, Math.min(anchor.top - popup.offsetHeight - 9, topEdge + height - popup.offsetHeight))
      const preferredLeft = align === "end" ? anchor.right - popup.offsetWidth : anchor.left
      const left = Math.max(leftEdge, Math.min(preferredLeft, leftEdge + width - popup.offsetWidth))
      popup.style.bottom = "auto"
      popup.style.top = `${top - anchor.top - parent.clientTop + parent.scrollTop}px`
      popup.style.left = `${left - anchor.left - parent.clientLeft + parent.scrollLeft}px`
      popup.style.right = "auto"
    }

    place()
    const observer = new ResizeObserver(place)
    observer.observe(popup)
    observer.observe(parent)
    if (chat) observer.observe(chat)
    const composer = parent.closest(".agent-composer-area")
    if (composer && composer !== parent) observer.observe(composer)
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    window.visualViewport?.addEventListener("resize", place)
    window.visualViewport?.addEventListener("scroll", place)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
      window.visualViewport?.removeEventListener("resize", place)
      window.visualViewport?.removeEventListener("scroll", place)
    }
  }, [open, ref, align])
}
