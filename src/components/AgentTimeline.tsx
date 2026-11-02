import { memo } from "react"
import { toolLabel, type TranscriptItem } from "../agents/transcript"
import type { AgentHistoryCapabilities, AgentPlanEntry } from "../agents/types"
import AgentIcon from "./AgentIcon"
import { AgentMessage, AgentToolResult } from "./AgentMessage"
import AgentDisclosure from "./AgentDisclosure"
import AgentProviderMark from "./AgentProviderMark"
import AgentRequest, { type AgentRequestActions } from "./AgentRequest"

type ActivityGroup = { kind: "activity-group"; id: string; items: TranscriptItem[]; failed: boolean; active: boolean }
type TimelineGroup = TranscriptItem | ActivityGroup

function ToolRow({ item }: { item: TranscriptItem }) {
  const label = toolLabel(item)
  const output = item.output && typeof item.output === "object" ? item.output as Record<string, unknown> : undefined
  const succeeded = item.status === "completed", failed = item.status === "failed" || item.status === "error"
  return <AgentDisclosure id={`detail:${item.id}`} className={`agent-tool ${failed ? "is-failed" : ""}`} summary={<><AgentIcon name={succeeded ? "check" : label.kind === "execute" ? "terminal" : label.kind === "search" ? "search" : label.kind === "edit" ? "edit" : "file"} size={14} />
      <span className="agent-tool-label"><span>{label.action}</span>{label.detail && <code title={label.detail}>{label.detail}</code>}</span>
      <small>{failed ? "Failed" : succeeded ? "Done" : item.status === "in_progress" || item.status === "running" ? "Running" : item.status === "cancelled" || item.status === "interrupted" ? "Stopped" : "Pending"}</small><AgentIcon name="chevron" size={12} /></>}>
    <div className="agent-tool-body">
      {item.input && <details className="agent-tool-input"><summary>Input</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details>}
      {!!item.content?.length && <AgentToolResult content={item.content} />}
      {item.text && !item.content?.length && <pre>{item.text}</pre>}
      {output?.exitCode !== undefined && <p className="agent-tool-exit">Exit code: {String(output.exitCode)}</p>}
      {item.output !== undefined && item.output !== null && <details className="agent-tool-input"><summary>Raw output</summary><pre>{JSON.stringify(item.output, null, 2) ?? String(item.output)}</pre></details>}
      {!item.content?.length && !item.text && !item.input && <p>No additional details supplied.</p>}
    </div>
    </AgentDisclosure>
}
type MessageActions = { capabilities?: AgentHistoryCapabilities; enabled: boolean; act: (message: TranscriptItem, retry: boolean) => void }
export const AgentTimeline = memo(function AgentTimeline({ items, agentName, agentId, plan, actions, requests, turnActive = false }: { items: TranscriptItem[]; agentName: string; agentId?: string; plan?: AgentPlanEntry[]; actions?: MessageActions; requests?: AgentRequestActions; turnActive?: boolean }) {
  const groups: TimelineGroup[] = []
  let activity: ActivityGroup | undefined
  for (const item of items) {
    if (item.kind === "reasoning" || item.kind === "tool") {
      if (!activity) {
        activity = { kind: "activity-group", id: item.id, items: [], failed: false, active: false }
        groups.push(activity)
      }
      activity.items.push(item)
      continue
    }
    if (item.kind === "notice" && item.status === "error" && activity) activity.failed = true
    activity = undefined
    groups.push(item)
  }
  const lastUserIndex = groups.reduce((last, group, index) => group.kind === "user" ? index : last, -1)
  const lastActivityIndex = groups.reduce((last, group, index) => group.kind === "activity-group" ? index : last, -1)
  const activeGroup = turnActive && lastActivityIndex === groups.length - 1 && lastActivityIndex > lastUserIndex ? groups[lastActivityIndex] as ActivityGroup : undefined
  if (activeGroup) activeGroup.active = true
  return <>{groups.map((group, index) => {
    if (group.kind === "activity-group") return <Activity key={group.id} group={group} />
    if (group.kind === "notice") return <p className={`agent-notice ${group.status === "error" ? "is-error" : ""}`} data-timeline-id={group.id} key={group.id}>{group.title && <strong>{group.title}: </strong>}{group.text}</p>
    if (group.kind === "tool") return <ToolRow key={group.id} item={group} />
    if (group.kind === "request") return requests?.expandedId === group.id ? <div key={group.id} data-timeline-id={group.id} className="agent-request-placeholder">Request opened in expanded view</div> : <AgentRequest key={group.id} item={group} actions={requests} />
    return <Message key={group.id} item={group} author={group.kind === "user" ? "You" : agentName} agentId={agentId || agentName} actions={actions} />
  })}
    {!!plan?.length && <AgentDisclosure className="agent-plan" summary={<><AgentIcon name="check" size={14} /><span>Plan</span><small>{plan.filter(entry => entry.status === "completed").length} of {plan.length} complete</small><AgentIcon name="chevron" size={12} /></>}><ol>{plan.map((entry, index) => <li key={index} className={entry.status}><span>{entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "•" : "○"}</span>{entry.content}</li>)}</ol></AgentDisclosure>}
  </>
})
const Message = memo(function Message({ item, author, agentId, actions }: { item: TranscriptItem; author: string; agentId: string; actions?: MessageActions }) {
  const { id, kind, text } = item
  const canAct = kind === "user" && item.messageId && item.checkpoint && actions
  return <article data-timeline-id={id} className={`agent-message agent-message-${kind}`}><div className="agent-message-author">{kind !== "user" && <AgentProviderMark id={agentId} size={19} />}{author}</div>{kind === "user" ? <p className="agent-user-text">{text}</p> : <AgentMessage text={text} />}
    {canAct && (actions.capabilities?.revert || actions.capabilities?.retry) && <div className="agent-message-actions" aria-label="Message actions">
      {actions.capabilities?.revert && <button type="button" disabled={!actions.enabled} title="Return to before this message; files stay as they are" onClick={() => actions.act(item, false)}><AgentIcon name="back" size={13} />Revert</button>}
      {actions.capabilities?.retry && <button type="button" disabled={!actions.enabled} title="Revert this message and later replies, then send it again with the selected model" onClick={() => actions.act(item, true)}><AgentIcon name="refresh" size={13} />Retry</button>}
    </div>}
  </article>
}, (before, after) => before.item.id === after.item.id && before.item.kind === after.item.kind && before.item.text === after.item.text && before.item.messageId === after.item.messageId && before.item.checkpoint === after.item.checkpoint && before.author === after.author && before.agentId === after.agentId && before.actions === after.actions)
function Activity({ group }: { group: ActivityGroup }) {
  const tools = group.items.filter(item => item.kind === "tool")
  const failedCount = tools.filter(item => item.status === "failed" || item.status === "error").length
  const active = tools.some(item => item.status === "running" || item.status === "in_progress")
  const stopped = tools.some(item => item.status === "cancelled" || item.status === "interrupted")
  const allDone = tools.length > 0 && tools.every(item => item.status === "completed")
  const pending = tools.some(item => !["completed", "failed", "error", "cancelled", "interrupted", "running", "in_progress"].includes(item.status || ""))
  const counts = new Map<string, number>()
  for (const item of tools) {
    const kind = toolLabel(item).kind
    const label = kind === "read" ? "read" : kind === "search" ? "search" : kind === "execute" ? "command" : kind === "edit" ? "edit" : "operation"
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  const plurals: Record<string, string> = { read: "reads", search: "searches", command: "commands", edit: "edits", operation: "operations" }
  const countSummary = [...counts].map(([label, count]) => `${count} ${count === 1 ? label : plurals[label]}`).join(" · ") || (group.items.some(item => item.kind === "reasoning") ? "Reasoning" : "")
  const status = group.failed ? "Interrupted" : failedCount ? `${failedCount} failed` : active ? "Working" : group.active ? "Thinking" : stopped ? "Stopped" : pending ? "Pending" : "Complete"
  const summary = ["Activity", countSummary, status].filter(Boolean).join(" · ")
  const icon = allDone && !failedCount && !group.failed ? "check" : "terminal"
  return <AgentDisclosure id={group.id} className={`agent-work-group${group.failed || failedCount ? " is-failed" : ""}${allDone && !failedCount ? " is-complete" : ""}`} summary={<><AgentIcon name={icon} size={14} /><span className="agent-work-summary">{summary}</span><AgentIcon name="chevron" size={12} /></>}>
    <div className="agent-work-group-body">{group.items.map(item => item.kind === "reasoning"
      ? <section className="agent-activity-reasoning" key={item.id}><h3>Reasoning</h3><AgentMessage text={item.text} /></section>
      : <ToolRow key={item.id} item={item} />)}</div>
  </AgentDisclosure>
}
