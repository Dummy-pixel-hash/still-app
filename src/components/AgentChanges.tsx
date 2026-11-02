/* THESIS: Review is an editor, not a stack of cards and toolbars.
 * OWN-WORLD: Still's smoked shell, neutral code canvas, rose selection and real +/-.
 * STORY: Choose a source, locate a file, read its patch; expand for deep review.
 * FIRST VIEWPORT: Quiet source tabs, compact scope, a file index and tall diff canvas.
 * FORM: Local T3/Codex-style operating surface, not a replacement app identity. */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { changeTotals, type AgentChange } from "../agents/changes"
import AgentIcon from "./AgentIcon"
import AgentConversationChanges from "./AgentConversationChanges"

export function ChangeNumbers({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="agent-change-numbers" aria-label={`${additions} additions, ${deletions} deletions`}><span>+{additions}</span><span>−{deletions}</span></span>
}

export function AgentChangeSummary({ changes, open }: { changes: AgentChange[]; open: () => void }) {
  const total = changeTotals(changes)
  const count = total.files || total.reportedFiles
  const label = `${count} ${total.files ? "changed" : "reported"} ${count === 1 ? "file" : "files"}`
  return <button className="agent-change-summary" onClick={open} aria-label={`Review ${label}`}>
    <AgentIcon name="changes" size={17} /><strong>{label}</strong>
    {total.files > 0 && total.exact && <ChangeNumbers additions={total.additions} deletions={total.deletions} />}
    {total.attempts > 0 && <small className="agent-change-attempts">{total.attempts} {total.attempts === 1 ? "edit not completed" : "edits not completed"}</small>}
    <span className="agent-change-summary-action">Review changes <AgentIcon name="chevron" size={13} /></span>
  </button>
}

export type AgentChangesMode = "repository" | "conversation"

export default function AgentChanges({ changes, close, mode, onModeChange, repository, repositoryCount }: {
  changes: AgentChange[]
  close: () => void
  mode: AgentChangesMode
  onModeChange: (mode: AgentChangesMode) => void
  repository: ReactNode
  repositoryCount?: number
}) {
  const root = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState(false)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  const [overlay, setOverlay] = useState(true)
  const modal = overlay || expanded
  const total = changeTotals(changes)
  const sourceCount = mode === "repository" ? repositoryCount : total.reportedFiles
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLButtonElement>(".agent-review-close")?.focus({ preventScroll: true })
    return () => { requestAnimationFrame(() => {
      const previous = returnFocus.current
      if (!root.current?.isConnected && previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true })
    }) }
  }, [])
  useLayoutEffect(() => {
    const body = root.current?.parentElement
    if (!body) return
    // Budget for both panes after navigation, not for the whole window.
    const update = () => setOverlay(body.clientWidth < 960)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const panel = root.current
    if (!panel || !modal) return
    const workspace = panel.closest(".agent-workspace")
    const siblings = [...(workspace?.querySelectorAll<HTMLElement>(".agent-sidebar,.agent-topbar,.agent-chat") || [])]
    const original = siblings.map(node => node.inert)
    siblings.forEach(node => { node.inert = true })
    if (!panel.contains(document.activeElement)) panel.querySelector<HTMLButtonElement>(".agent-review-close")?.focus({ preventScroll: true })
    return () => { siblings.forEach((node, index) => { node.inert = original[index] }) }
  }, [modal])
  return <>{modal && <button className="agent-review-scrim" tabIndex={-1} aria-label="Close changes panel" onClick={close} />}<aside ref={root} className={`agent-review${overlay ? " is-overlay" : ""}${expanded ? " is-expanded" : ""}`} role={modal ? "dialog" : "complementary"} aria-modal={modal || undefined} aria-label={mode === "repository" ? "Repository changes" : "Conversation changes"} tabIndex={-1} onKeyDown={event => {
    if (modal) event.stopPropagation()
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
      && event.target instanceof HTMLElement && event.target.closest("[role=tablist]")?.getAttribute("aria-label") === "Change source") {
      const tabs = [...(root.current?.querySelectorAll<HTMLButtonElement>(".agent-review-views > [role=tab]") || [])]
      const index = tabs.indexOf(event.target as HTMLButtonElement)
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : event.key === "ArrowRight" ? (index + 1) % tabs.length : (index + tabs.length - 1) % tabs.length
      event.preventDefault()
      tabs[next]?.focus()
      tabs[next]?.click()
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === "Tab" && modal) {
      const nodes = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]') || [])].filter(node => node.getClientRects().length && !node.closest("[inert]"))
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus() }
    }
  }}>
    <header className="agent-review-header"><div><AgentIcon name="changes" size={16} /><h2>Changes</h2>{sourceCount !== undefined && <span>{sourceCount} {sourceCount === 1 ? "file" : "files"}</span>}</div><div className="agent-review-window-actions"><button type="button" className="agent-icon-button agent-review-expand" aria-label={expanded ? "Restore changes panel" : "Expand changes"} title={expanded ? "Restore panel" : "Expand review"} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}><AgentIcon name={expanded ? "panel" : "expand"} size={16} /></button><button className="agent-icon-button agent-review-close" aria-label="Close changes" onClick={close}><AgentIcon name="close" size={17} /></button></div></header>
    <div className="agent-review-views" role="tablist" aria-label="Change source">
      <button id="agent-review-tab-repository" type="button" role="tab" aria-selected={mode === "repository"} aria-description={repositoryCount === undefined ? "Repository files have not been checked" : `${repositoryCount} repository ${repositoryCount === 1 ? "file" : "files"}`} aria-controls="agent-review-panel" tabIndex={mode === "repository" ? 0 : -1} onClick={() => onModeChange("repository")}>Repository{repositoryCount !== undefined && <span aria-hidden="true">{repositoryCount}</span>}</button>
      <button id="agent-review-tab-conversation" type="button" role="tab" aria-selected={mode === "conversation"} aria-description={`${total.reportedFiles} files reported by this conversation`} aria-controls="agent-conversation-review-panel" tabIndex={mode === "conversation" ? 0 : -1} onClick={() => onModeChange("conversation")}>Conversation<span aria-hidden="true">{total.reportedFiles}</span></button>
    </div>
    <div id="agent-review-panel" className="agent-review-tabpanel" role="tabpanel" aria-labelledby="agent-review-tab-repository" tabIndex={0} hidden={mode !== "repository"}>{repository}</div>
    <div id="agent-conversation-review-panel" className="agent-review-tabpanel" role="tabpanel" aria-labelledby="agent-review-tab-conversation" tabIndex={0} hidden={mode !== "conversation"}>
      <AgentConversationChanges changes={changes} openRepository={() => onModeChange("repository")} />
    </div>
  </aside></>
}
