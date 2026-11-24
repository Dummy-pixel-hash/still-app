const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])'

/** Keep Tab / Shift+Tab inside `container` (modal dialogs). Returns true if it acted. */
export function trapTab(e: { key: string; shiftKey: boolean; preventDefault(): void }, container: HTMLElement | null): boolean {
  if (e.key !== "Tab" || !container) return false
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
  if (items.length === 0) return false
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault()
    last.focus()
    return true
  }
  if (!e.shiftKey && (active === last || !container.contains(active))) {
    e.preventDefault()
    first.focus()
    return true
  }
  return false
}
