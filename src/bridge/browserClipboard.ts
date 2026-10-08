/** Browser-preview clipboard only. Packaged Still uses the native OS bridge. */
export async function writeBrowserClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Older/permission-limited WebViews may still allow a user-initiated copy.
    }
  }

  const focused = document.activeElement as HTMLElement | null
  const field = document.createElement("textarea")
  field.value = text
  field.readOnly = true
  field.tabIndex = -1
  field.setAttribute("aria-hidden", "true")
  field.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0"
  document.body.appendChild(field)
  try {
    field.select()
    if (!document.execCommand("copy")) throw new Error("Clipboard copy was denied.")
  } finally {
    field.remove()
    if (focused?.isConnected) focused.focus({ preventScroll: true })
  }
}

export async function readBrowserClipboard(): Promise<string> {
  if (!navigator.clipboard?.readText) {
    throw new Error("Clipboard reading is unavailable. Use the terminal's paste menu.")
  }
  return navigator.clipboard.readText()
}
