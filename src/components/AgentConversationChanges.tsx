import { useMemo, useState } from "react"
import { changeTotals, type AgentChange } from "../agents/changes"
import AgentIcon from "./AgentIcon"
import AgentReviewFiles, { ReviewFileSelect } from "./AgentReviewFiles"
import { AgentChangeView } from "./AgentMessage"
import { ChangeNumbers } from "./AgentChanges"

export default function AgentConversationChanges({ changes, openRepository }: { changes: AgentChange[]; openRepository: () => void }) {
  const [selected, setSelected] = useState("")
  const groups = useMemo(() => {
    const byPath = new Map<string, AgentChange[]>()
    for (const change of changes) {
      const entries = byPath.get(change.path)
      if (entries) entries.push(change)
      else byPath.set(change.path, [change])
    }
    return [...byPath].map(([path, entries]) => ({ path, entries, total: changeTotals(entries) }))
  }, [changes])
  const current = groups.find(group => group.path === selected) || groups[0]
  const total = changeTotals(changes)
  const index = groups.indexOf(current)
  return <section className="agent-conversation-review" aria-label="Agent-reported edits">
    <div className="agent-review-context"><span>{total.attempts ? total.files ? "Reported edits · totals exclude incomplete attempts" : "No completed edits reported" : "From this conversation"}</span>{total.files > 0 && total.exact && <ChangeNumbers additions={total.additions} deletions={total.deletions} />}</div>
    {current ? <>
      <div className="agent-review-browser">
        <AgentReviewFiles source="conversation" selected={current.path} select={setSelected} files={groups.map(group => ({
          id: group.path, path: group.path, label: `${group.entries.length} reported ${group.entries.length === 1 ? "edit" : "edits"}`,
          status: group.entries.every(entry => entry.outcome === "failed") ? "!" : group.entries.some(entry => entry.outcome === "pending") ? "…" : "M",
          counts: group.total.files > 0 && group.total.exact ? <ChangeNumbers additions={group.total.additions} deletions={group.total.deletions} /> : undefined,
        }))} />
        <div className="agent-review-editor">
          <ReviewFileSelect source="conversation" files={groups.map(group => ({ id: group.path, path: group.path }))} selected={current.path} select={setSelected} />
          <div className="agent-code-language agent-review-file-toolbar"><AgentIcon name="file" size={14} /><span title={current.path}>{current.path}</span>
            <div className="agent-review-file-pager"><span>{index + 1} / {groups.length}</span>
              <button type="button" aria-label="Previous changed file" disabled={index <= 0} onClick={() => setSelected(groups[index - 1].path)}><AgentIcon name="back" size={14} /></button>
              <button type="button" aria-label="Next changed file" disabled={index >= groups.length - 1} onClick={() => setSelected(groups[index + 1].path)}><AgentIcon name="back" size={14} style={{ transform: "rotate(180deg)" }} /></button>
            </div>
          </div>
          <div className="agent-review-diff" key={current.path} tabIndex={0} role="region" aria-label={`Diff for ${current.path}`}>
            {current.entries.map((change, editIndex, list) => <section key={change.id} aria-label={list.length > 1 ? `Reported edit ${editIndex + 1}` : current.path}>
              {list.length > 1 && <div className="agent-review-edit">Reported edit {editIndex + 1} of {list.length}</div>}
              {change.outcome !== "completed" && <p className={`agent-change-outcome is-${change.outcome}`}>{change.outcome === "failed" ? "Edit failed · attempted patch" : change.outcome === "pending" ? "Edit pending · completion not reported" : "Outcome not reported · supplied patch"}</p>}
              <AgentChangeView change={change} header={false} />
            </section>)}
          </div>
        </div>
      </div>
      <p className="agent-review-note"><AgentIcon name="chat" size={12} />Reported edits, not the current working tree.<button type="button" onClick={openRepository}>View repository<AgentIcon name="chevron" size={12} /></button></p>
    </> : <div className="agent-review-empty"><AgentIcon name="changes" size={24} /><h3>No reported changes yet</h3><p>This agent hasn’t supplied an edit preview. A tool can edit files without returning a patch.</p><button type="button" className="agent-button" onClick={openRepository}>View repository changes<AgentIcon name="chevron" size={13} /></button></div>}
  </section>
}
