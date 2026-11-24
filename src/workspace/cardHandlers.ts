import type { PointerEvent as ReactPointerEvent } from "react"
import type { Session } from "../types"

/** Stable callbacks shared by every card (the grid is memoized on them). */
export interface CardHandlers {
  onOpen: (s: Session, el: HTMLElement) => void
  onOpenAgent: (s: Session) => void
  onEdit: (s: Session) => void
  onRemove: (s: Session) => void
  onToggleMenu: (id: string | null) => void
  onCardPointerDown: (e: ReactPointerEvent, s: Session, el: HTMLElement) => void
  onMove: (s: Session, direction: -1 | 1) => void
  onMoveToProject: (s: Session, projectId: string) => void
  onCardFocus: (id: string) => void
}
