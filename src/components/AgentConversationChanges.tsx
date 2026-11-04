import { useMemo, useState } from "react"
import { changeTotals, type AgentChange } from "../agents/changes"
import AgentIcon from "./AgentIcon"
import AgentReviewFiles, { ReviewPath } from "./AgentReviewFiles"
import AgentReviewDiff from "./AgentReviewDiff"
import { ChangeNumbers } from "./AgentChanges"

export default function AgentConversationChanges({ changes }: { changes: AgentChange[] }) {
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
  return <section className="agent-conversation-review">
    {total.attempts > 0 && <p className="agent-review-warning" role="status">{total.files ? "Incomplete edit attempts are excluded from totals." : "No completed edits reported."}{total.files > 0 && total.exact && <ChangeNumbers additions={total.additions} deletions={total.deletions} />}</p>}
    {current ? <>
      <div className="agent-review-browser">
        <AgentReviewFiles source="conversation" selected={current.path} select={setSelected} files={groups.map(group => ({
          id: group.path, path: group.path, label: `${group.entries.length} reported ${group.entries.length === 1 ? "edit" : "edits"}`,
          status: group.entries.every(entry => entry.outcome === "failed") ? "!" : group.entries.some(entry => entry.outcome === "pending") ? "…" : "M",
          counts: group.total.files > 0 && group.total.exact ? <ChangeNumbers additions={group.total.additions} deletions={group.total.deletions} /> : undefined,
        }))} />
        <div className="agent-review-editor">
          <header className="agent-review-file-header"><div className="agent-review-file-identity"><AgentIcon name="file" size={16} /><span className="agent-review-selected-path" title={current.path}><ReviewPath path={current.path} /></span></div><div className="agent-review-file-actions">{current.total.files > 0 && current.total.exact && <ChangeNumbers additions={current.total.additions} deletions={current.total.deletions} />}<span className="agent-review-edit-count">{groups.indexOf(current) + 1} of {groups.length}</span></div></header>
          <div className="agent-review-diff" key={current.path} tabIndex={0} role="region" aria-label={`Diff for ${current.path}`}>
            {current.entries.map((change, editIndex, list) => <section key={change.id} aria-label={list.length > 1 ? `Reported edit ${editIndex + 1}` : current.path}>
              {list.length > 1 && <div className="agent-review-edit">Reported edit {editIndex + 1} of {list.length}</div>}
              {change.outcome !== "completed" && <p className={`agent-change-outcome is-${change.outcome}`}>{change.outcome === "failed" ? "Edit failed · attempted patch" : change.outcome === "pending" ? "Edit pending · completion not reported" : "Outcome not reported · supplied patch"}</p>}
              <AgentReviewDiff change={change} />
            </section>)}
          </div>
        </div>
      </div>
    </> : <div className="agent-review-empty"><AgentIcon name="changes" size={24} /><h3>No reported changes yet</h3><p>This agent hasn’t supplied an edit preview. A tool can edit files without returning a patch.</p></div>}
  </section>
}
