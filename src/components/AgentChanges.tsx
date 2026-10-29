import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { changeTotals, type AgentChange } from "../agents/changes"
import AgentIcon from "./AgentIcon"
import { AgentChangeView } from "./AgentMessage"

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

export default function AgentChanges({ changes, close }: { changes: AgentChange[]; close: () => void }) {
  const root = useRef<HTMLElement>(null), [selected, setSelected] = useState("")
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  const [overlay, setOverlay] = useState(() => matchMedia("(max-width: 1000px)").matches)
  const files = useMemo(() => [...new Set(changes.map(change => change.path))], [changes])
  const path = files.includes(selected) ? selected : files[0]
  const total = changeTotals(changes)
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLButtonElement>(".agent-review-close")?.focus({ preventScroll: true })
    return () => { requestAnimationFrame(() => {
      const previous = returnFocus.current
      if (!root.current?.isConnected && previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true })
    }) }
  }, [])
  useEffect(() => {
    const query = matchMedia("(max-width: 1000px)")
    const update = () => setOverlay(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  useLayoutEffect(() => {
    const panel = root.current
    if (!panel || !overlay) return
    const workspace = panel.closest(".agent-workspace")
    const siblings = [...(workspace?.querySelectorAll<HTMLElement>(".agent-sidebar,.agent-topbar,.agent-chat") || [])]
    const original = siblings.map(node => node.inert)
    siblings.forEach(node => { node.inert = true })
    if (!panel.contains(document.activeElement)) panel.querySelector<HTMLButtonElement>(".agent-review-close")?.focus({ preventScroll: true })
    return () => { siblings.forEach((node, index) => { node.inert = original[index] }) }
  }, [overlay])
  return <aside ref={root} className="agent-review" role={overlay ? "dialog" : "complementary"} aria-modal={overlay || undefined} aria-label="Conversation changes" tabIndex={-1} onKeyDown={event => {
    if (overlay) event.stopPropagation()
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === "Tab" && overlay) {
      const nodes = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,a[href],summary,[tabindex="0"]') || [])].filter(node => node.getClientRects().length)
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus() }
    }
  }}>
    <header className="agent-review-header"><div><AgentIcon name="changes" size={16} /><h2>Changes</h2><span>{total.reportedFiles}</span></div><button className="agent-icon-button agent-review-close" aria-label="Close changes" onClick={close}><AgentIcon name="close" size={17} /></button></header>
    <div className="agent-review-context"><span>{total.attempts ? total.files ? "Completed edits only" : "No completed edits reported" : "From this conversation"}</span>{total.files > 0 && total.exact && <ChangeNumbers additions={total.additions} deletions={total.deletions} />}</div>
    {files.length ? <>
      <div className="agent-review-files" aria-label="Changed files">{files.map(file => {
        const entries = changes.filter(c => c.path === file), totals = changeTotals(entries)
        return <button key={file} aria-pressed={file === path} className={file === path ? "is-selected" : ""} onClick={() => setSelected(file)} title={file}><AgentIcon name="file" size={14} /><span>{file}</span>{totals.files > 0 && totals.exact ? <ChangeNumbers additions={totals.additions} deletions={totals.deletions} /> : totals.attempts > 0 && <small className="agent-change-attempts">{entries.every(entry => entry.outcome === "failed") ? "Failed" : entries.every(entry => entry.outcome === "pending") ? "Pending" : "Unconfirmed"}</small>}</button>
      })}</div>
      <div className="agent-review-diff" key={path} tabIndex={0} role="region" aria-label={`Diff for ${path}`}>{changes.filter(c => c.path === path).map((change, index, list) => <section key={change.id} aria-label={list.length > 1 ? `Reported edit ${index + 1}` : path}>{list.length > 1 && <div className="agent-review-edit">Reported edit {index + 1} of {list.length}</div>}{change.outcome !== "completed" && <p className={`agent-change-outcome is-${change.outcome}`}>{change.outcome === "failed" ? "Edit failed · attempted patch" : change.outcome === "pending" ? "Edit pending · completion not reported" : "Outcome not reported · supplied patch"}</p>}<AgentChangeView change={change} /></section>)}</div>
      <p className="agent-review-note">Agent-reported changes, in order. Your server’s current files may have changed since.</p>
    </> : <div className="agent-review-empty"><AgentIcon name="file" size={25} /><h3>No reported changes yet</h3><p>File edits supplied by your agent will appear here.</p></div>}
  </aside>
}
