// Stable DOM lookups for workspace focus management. Every "return focus to
// the card" path (overlay close, menu Open, Agents' Open terminal, the orb)
// goes through these so they all land on the same element.

const esc = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"'))

/** The card's outer element (geometry source for the card-origin morph). */
export function cardEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-card="${esc(id)}"]`)
}

/** The card's full-card "Open" button: the right place for focus to return to. */
export function cardOpenButton(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-card="${esc(id)}"] [data-card-open]`)
}

export function focusCardOpen(id: string): boolean {
  const el = cardOpenButton(id)
  if (!el) return false
  el.focus({ preventScroll: true })
  return true
}

/** The temp dock's container: where focus goes after a temp terminal is minimized. */
export function tempPill(): HTMLElement | null {
  return document.getElementById("temp-pill")
}
