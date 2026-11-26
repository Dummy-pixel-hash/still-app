import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import AgentIcon from "./AgentIcon"
import { nativeBridge } from "../bridge/nativeBridge"

export type AgentNoticeTone = "info" | "attention" | "error" | "working" | "ok"

/**
 * One calm line for any error or notice: a 6px tone dot, a short sentence and a few
 * non-wrapping actions. Raw or technical text belongs in `detail`, which opens inline
 * in a capped, scrollable, copyable block. The full detail text stays in the DOM
 * (hidden) so assistive tech and text queries can still reach it.
 */
export default function AgentNotice({ tone, text, detail, actions, note, role, onDismiss, className = "", label }: {
  tone: AgentNoticeTone
  text: ReactNode
  detail?: string
  actions?: ReactNode
  /** A muted guidance line under the notice, clamped to two lines. */
  note?: ReactNode
  role?: "alert" | "status"
  onDismiss?: () => void
  className?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const detailId = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => { if (!detail) setOpen(false) }, [detail])
  const copy = () => {
    if (!detail) return
    void nativeBridge.clipboardWriteText(detail).then(() => { setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1400) }).catch(() => undefined)
  }
  return <div className={`agent-notice-row is-${tone} ${className}`.trim()} role={role} aria-label={label}>
    <div className="agent-notice-line">
      <span className="agent-notice-dot" aria-hidden="true" />
      <span className="agent-notice-text" title={typeof text === "string" ? text : undefined}>{text}</span>
      {(detail || actions || onDismiss) && <span className="agent-notice-actions">
        {detail && <button type="button" className="agent-notice-action" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(value => !value)}>Details</button>}
        {actions}
        {onDismiss && <button type="button" className="agent-notice-dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}><AgentIcon name="close" size={12} /></button>}
      </span>}
    </div>
    {note && <p className="agent-notice-note" title={typeof note === "string" ? note : undefined}>{note}</p>}
    {detail && <div id={detailId} className="agent-notice-detail" hidden={!open}>
      <pre tabIndex={0} aria-label="Error details">{detail}</pre>
      <button type="button" className="agent-notice-action agent-notice-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>}
  </div>
}

export type TopNotice = { id: string; tone: AgentNoticeTone; text: ReactNode; detail?: string; actions?: ReactNode; role?: "alert" | "status"; className?: string }
const SEVERITY: Record<AgentNoticeTone, number> = { error: 0, attention: 1, working: 2, info: 3, ok: 4 }

/** The single notice row above the conversation. Extra notices open in a popover that overlays the transcript. */
export function AgentNoticeBar({ notices }: { notices: TopNotice[] }) {
  const ordered = notices.map((notice, index) => ({ notice, index })).sort((a, b) => SEVERITY[a.notice.tone] - SEVERITY[b.notice.tone] || a.index - b.index).map(entry => entry.notice)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const popoverId = useId()
  const extra = ordered.length - 1
  useEffect(() => { if (extra <= 0) setOpen(false) }, [extra])
  useEffect(() => {
    if (!open) return
    const close = (restore: boolean) => { setOpen(false); if (restore) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })) }
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(true) } }
    const pointer = (event: PointerEvent) => { const target = event.target as Node; if (!popover.current?.contains(target) && !trigger.current?.contains(target)) close(false) }
    document.addEventListener("keydown", key, true)
    document.addEventListener("pointerdown", pointer, true)
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", pointer, true) }
  }, [open])
  if (!ordered.length) return null
  const [first, ...rest] = ordered
  return <div className="agent-notice-bar">
    <div className="agent-notice-bar-row">
      <AgentNotice key={first.id} tone={first.tone} text={first.text} detail={first.detail} actions={first.actions} role={first.role} className={first.className} />
      {extra > 0 && <button ref={trigger} type="button" className="agent-notice-more" aria-haspopup="dialog" aria-expanded={open} aria-controls={popoverId} onClick={() => setOpen(value => !value)}>+{extra} more</button>}
    </div>
    {open && extra > 0 && <div ref={popover} id={popoverId} className="agent-notice-popover" role="dialog" aria-label="More notices">
      {rest.map(notice => <AgentNotice key={notice.id} tone={notice.tone} text={notice.text} detail={notice.detail} actions={notice.actions} role={notice.role} className={notice.className} />)}
    </div>}
  </div>
}
