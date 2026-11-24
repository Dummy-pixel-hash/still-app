// One registry for every keyboard shortcut the app owns.
//
// Rules this file encodes (see DESIGN.md "Terminal themes"/keys):
//  * Inside xterm, Ctrl+/ and Ctrl+K belong to the shell (undo / kill-line).
//    In-terminal app shortcuts therefore use Ctrl+Shift+letter or F6.
//  * The overlay's capture-phase gate and SessionTerminal's
//    attachCustomKeyEventHandler backstop BOTH match through this registry,
//    so the two can never disagree about what a key means.

export type ShortcutId =
  | "close"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "find"
  | "palette"
  | "help"
  | "controls"
  | "workspacePalette"
  | "search"
  | "newTemp"
  | "agents"
  | "copy"
  | "paste"

export type ShortcutGroup = "In a terminal" | "Workspace" | "Anywhere"

export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

export interface ShortcutDef {
  id: ShortcutId
  label: string
  keys: string
  group: ShortcutGroup
  /** Present only for shortcuts that act inside the terminal surface. */
  match?: (e: KeyLike) => boolean
  /** True when the shortcut still works while a text field has focus. */
  worksInFields?: boolean
}

const plainCtrl = (e: KeyLike) => e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing
const ctrlShift = (e: KeyLike) => plainCtrl(e) && e.shiftKey
const lower = (e: KeyLike) => e.key.toLowerCase()

const isClose = (e: KeyLike) => plainCtrl(e) && (e.code === "Period" || lower(e) === "." || lower(e) === ">")
const isReset = (e: KeyLike) => plainCtrl(e) && (lower(e) === "0" || e.code === "Digit0" || e.code === "Numpad0")
const isZoomOut = (e: KeyLike) => plainCtrl(e) && (lower(e) === "-" || lower(e) === "_" || e.code === "Minus" || e.code === "NumpadSubtract")
const isZoomIn = (e: KeyLike) => plainCtrl(e) && (lower(e) === "=" || lower(e) === "+" || e.code === "Equal" || e.code === "NumpadAdd")
const isFind = (e: KeyLike) => ctrlShift(e) && (e.code === "KeyF" || lower(e) === "f")
const isPalette = (e: KeyLike) => ctrlShift(e) && (e.code === "KeyK" || lower(e) === "k")
const isHelp = (e: KeyLike) => ctrlShift(e) && (e.code === "Slash" || e.key === "?" || e.key === "/")
const isControls = (e: KeyLike) => e.key === "F6" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "close", label: "Back to the workspace", keys: "Ctrl+.", group: "In a terminal", match: isClose, worksInFields: true },
  { id: "zoomIn", label: "Larger text (this terminal)", keys: "Ctrl+=", group: "In a terminal", match: isZoomIn },
  { id: "zoomOut", label: "Smaller text (this terminal)", keys: "Ctrl+-", group: "In a terminal", match: isZoomOut },
  { id: "zoomReset", label: "Reset text size", keys: "Ctrl+0", group: "In a terminal", match: isReset },
  { id: "find", label: "Find in scrollback", keys: "Ctrl+Shift+F", group: "In a terminal", match: isFind, worksInFields: true },
  { id: "palette", label: "Command palette", keys: "Ctrl+Shift+K", group: "In a terminal", match: isPalette, worksInFields: true },
  { id: "help", label: "Keyboard shortcuts", keys: "Ctrl+Shift+/", group: "In a terminal", match: isHelp, worksInFields: true },
  { id: "controls", label: "Move to the controls bar", keys: "F6", group: "In a terminal", match: isControls, worksInFields: true },
  { id: "copy", label: "Copy selection", keys: "Ctrl+Shift+C", group: "In a terminal" },
  { id: "paste", label: "Paste", keys: "Ctrl+Shift+V", group: "In a terminal" },
  { id: "workspacePalette", label: "Command palette", keys: "Ctrl+K", group: "Workspace" },
  { id: "search", label: "Filter sessions", keys: "/", group: "Workspace" },
  { id: "newTemp", label: "New temp terminal", keys: "Ctrl+Shift+T", group: "Anywhere" },
  { id: "agents", label: "Open or close Agents", keys: "Ctrl+Shift+A", group: "Anywhere" },
]

const TERMINAL_MATCHERS = SHORTCUTS.filter((s) => s.match)

/** Which in-terminal shortcut (if any) this key event is. */
export function matchTerminalShortcut(e: KeyLike): ShortcutId | null {
  for (const s of TERMINAL_MATCHERS) if (s.match!(e)) return s.id
  return null
}

export function shortcutDef(id: ShortcutId): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id)
}

/** True for text inputs, selects and contenteditable (but not xterm's helper textarea). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.classList?.contains("xterm-helper-textarea")) return false
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable
}

export function groupedShortcuts(): { group: ShortcutGroup; items: ShortcutDef[] }[] {
  const order: ShortcutGroup[] = ["In a terminal", "Workspace", "Anywhere"]
  return order.map((group) => ({ group, items: SHORTCUTS.filter((s) => s.group === group) }))
}
