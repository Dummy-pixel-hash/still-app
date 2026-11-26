import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react"

export interface MenuItemDef {
  id: string
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Keep the menu open after selecting (used for in-menu navigation). */
  keepOpen?: boolean
  /** Move focus back to the menu button after selecting (default: no). */
  restoreFocus?: boolean
}

/**
 * Props for the button that owns a menu: haspopup/expanded/controls, plus
 * ArrowDown/ArrowUp to open it from the keyboard.
 */
export function useMenuButton({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()
  return {
    ref,
    menuId,
    props: {
      "aria-haspopup": "menu" as const,
      "aria-expanded": open,
      "aria-controls": open ? menuId : undefined,
      onClick: (e: ReactMouseEvent) => {
        e.stopPropagation()
        onOpenChange(!open)
      },
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault()
          e.stopPropagation()
          onOpenChange(true)
        }
      },
    },
  }
}

/**
 * Neutral contextual menu (menu / menuitem roles). Up/Down/Home/End and
 * typeahead move focus; Escape or Tab closes and returns focus to the owning
 * button; a pointer press outside closes it. Positioning comes from the
 * caller's className inside a `relative` wrapper.
 */
export default function Menu({
  id,
  label,
  items,
  anchorRef,
  onClose,
  className = "",
}: {
  id: string
  label: string
  items: MenuItemDef[]
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: "", at: 0 })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const enabled = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])

  // Focus the first item when the menu appears (and when its items change view).
  const key = items.map((i) => i.id).join("|")
  useEffect(() => {
    const raf = requestAnimationFrame(() => enabled()[0]?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
  }, [key])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return
      closeRef.current()
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [anchorRef])

  const focusAnchor = () => anchorRef.current?.focus({ preventScroll: true })

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      focusAnchor()
      return
    }
    if (e.key === "Tab") {
      // Close and put focus back on the button; the default Tab then moves on
      // from there instead of walking through hidden menu items.
      onClose()
      focusAnchor()
      return
    }
    const list = enabled()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    let next: HTMLButtonElement | undefined
    if (e.key === "ArrowDown") next = list[(index + 1) % list.length]
    else if (e.key === "ArrowUp") next = list[(index - 1 + list.length) % list.length]
    else if (e.key === "Home") next = list[0]
    else if (e.key === "End") next = list[list.length - 1]
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      const now = Date.now()
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now }
      const from = typed.current.text.length > 1 ? index : index + 1
      for (let i = 0; i < list.length; i++) {
        const candidate = list[(from + i + list.length) % list.length]
        if (candidate.textContent?.trim().toLowerCase().startsWith(typed.current.text)) {
          next = candidate
          break
        }
      }
      if (!next) return
    } else return
    e.preventDefault()
    e.stopPropagation()
    next?.focus({ preventScroll: true })
  }

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      data-menu
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className={`absolute z-30 flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#121214]/95 py-1 text-[13px] shadow-[0_16px_40px_rgba(0,0,0,0.7)] backdrop-blur-xl ${className}`}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          onClick={(e) => {
            e.stopPropagation()
            item.onSelect()
            if (!item.keepOpen) onClose()
            if (item.restoreFocus) requestAnimationFrame(focusAnchor)
          }}
          className={`px-3 py-1.5 text-left transition hover:bg-white/[0.07] focus-visible:bg-white/[0.09] disabled:opacity-40 ${
            item.danger ? "text-[#ff8080]" : "text-dim hover:text-fg focus-visible:text-fg"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
