/* THESIS: A Still-native review desk, not an edge-to-edge editor bolted onto chat.
 * OWN-WORLD: One smoked-glass shell, silver edge, warm text, rose selection.
 * STORY: Choose a source, find a file, read its real patch, return without losing work.
 * FIRST VIEWPORT: Inset shell header, file navigation, generous uninterrupted diff.
 * FORM: Existing Still material and control language; dedicated desktop workspace. */
import { useLayoutEffect, type ReactNode } from "react"
import { changeTotals, type AgentChange } from "../agents/changes"
import AgentIcon from "./AgentIcon"
import AgentConversationChanges from "./AgentConversationChanges"

export function ChangeNumbers({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="agent-change-numbers" aria-label={`${additions} additions, ${deletions} deletions`}><span>+{additions}</span><span>−{deletions}</span></span>
}

export function AgentChangeSummary({ changes, open }: { changes: AgentChange[]; open: (trigger: HTMLButtonElement) => void }) {
  const total = changeTotals(changes)
  const count = total.files || total.reportedFiles
  const label = `${count} ${total.files ? "changed" : "reported"} ${count === 1 ? "file" : "files"}`
  return <button className="agent-change-summary" onClick={event => open(event.currentTarget)} aria-label={`Review ${label}`}>
    <AgentIcon name="changes" size={17} /><strong>{label}</strong>
    {total.files > 0 && total.exact && <ChangeNumbers additions={total.additions} deletions={total.deletions} />}
    {total.attempts > 0 && <small className="agent-change-attempts">{total.attempts} {total.attempts === 1 ? "edit not completed" : "edits not completed"}</small>}
    <span className="agent-change-summary-action">Review changes <AgentIcon name="chevron" size={13} /></span>
  </button>
}

export type AgentChangesMode = "repository" | "conversation"

export default function AgentChanges({ changes, mode, onModeChange, repository, repositoryCount }: {
  changes: AgentChange[]
  mode: AgentChangesMode
  onModeChange: (mode: AgentChangesMode) => void
  repository: ReactNode
  repositoryCount?: number
}) {
  const total = changeTotals(changes)

  useLayoutEffect(() => {
    document.querySelector<HTMLButtonElement>(".agent-review-back")?.focus({ preventScroll: true })
  }, [])

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")]
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1
    if (next < 0) return
    event.preventDefault()
    tabs[next]?.focus()
    tabs[next]?.click()
  }

  return <section className="agent-review" role="region" aria-label={mode === "repository" ? "Repository changes" : "Conversation changes"}>
    <header className="agent-review-header">
      <div className="agent-review-heading"><AgentIcon name="changes" size={21} /><div><h2>Changes <span className="agent-review-count">{mode === "repository" ? repositoryCount === undefined ? "" : `${repositoryCount} ${repositoryCount === 1 ? "file" : "files"}` : `${total.reportedFiles} ${total.reportedFiles === 1 ? "file" : "files"}`}</span></h2><p>{mode === "repository" ? "Your working tree, as last checked." : "Edits reported in this conversation."}</p></div></div>
      <div className="agent-review-views" role="tablist" aria-label="Change source" onKeyDown={onTabKeyDown}>
      <button id="agent-review-tab-repository" type="button" role="tab" aria-selected={mode === "repository"} aria-description={repositoryCount === undefined ? "Repository files have not been checked" : `${repositoryCount} repository ${repositoryCount === 1 ? "file" : "files"}`} aria-controls="agent-review-panel" tabIndex={mode === "repository" ? 0 : -1} onClick={() => onModeChange("repository")}>Repository</button>
      <button id="agent-review-tab-conversation" type="button" role="tab" aria-selected={mode === "conversation"} aria-description={`${total.reportedFiles} files reported by this conversation`} aria-controls="agent-conversation-review-panel" tabIndex={mode === "conversation" ? 0 : -1} onClick={() => onModeChange("conversation")}>Conversation</button>
      </div>
    </header>
    <div id="agent-review-panel" className="agent-review-tabpanel" role="tabpanel" aria-label="Repository changes" aria-labelledby="agent-review-tab-repository" hidden={mode !== "repository"}>{repository}</div>
    <div id="agent-conversation-review-panel" className="agent-review-tabpanel" role="tabpanel" aria-label="Conversation changes" aria-labelledby="agent-review-tab-conversation" hidden={mode !== "conversation"}>
      <AgentConversationChanges changes={changes} />
    </div>
  </section>
}
