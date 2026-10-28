import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

/** Keep contextual actions outside sidebar overflow while retaining its focus owner. */
export default function AgentMenu({ children, root, role = "menu", label, className = "" }: {
  children: ReactNode
  root: HTMLElement | null
  role?: "menu" | "dialog"
  label?: string
  className?: string
}) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  useLayoutEffect(() => {
    const anchor = [...(root?.querySelectorAll<HTMLElement>('.agent-thread-more[aria-expanded="true"]') || [])].find(node => node.getClientRects().length && !node.closest("[inert]"))
    if (!anchor) return
    const place = () => {
      const box = anchor.getBoundingClientRect(), height = menu.current?.offsetHeight || 230, width = menu.current?.offsetWidth || 196
      setPosition({ left: Math.max(12, Math.min(innerWidth - width - 12, box.right - width)), top: Math.max(12, box.bottom + height + 12 < innerHeight ? box.bottom + 4 : box.top - height - 4) })
    }
    place(); menu.current?.querySelector<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)')?.focus({ preventScroll: true })
    window.addEventListener("resize", place)
    root?.addEventListener("scroll", place, true)
    return () => { window.removeEventListener("resize", place); root?.removeEventListener("scroll", place, true); if (anchor.isConnected) anchor.focus({ preventScroll: true }) }
  }, [root])
  const content = <div ref={menu} className={`agent-thread-menu ${className}`} role={role} aria-label={label} style={{ position: "fixed", ...position }} onKeyDown={event => {
    if (role !== "menu" || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }}>{children}</div>
  return root ? createPortal(content, root) : content
}
