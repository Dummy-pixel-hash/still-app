import { memo, useEffect, useId, useRef, useState } from "react"
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
  const failed = item.status === "failed" || item.status === "error"
  return <article className={`agent-tool agent-tool--inline ${failed ? "is-failed" : ""}`} data-timeline-id={`detail:${item.id}`}>
    <header className="agent-tool-heading"><AgentIcon name={failed ? "file" : label.kind === "execute" ? "terminal" : label.kind === "search" ? "search" : label.kind === "edit" ? "edit" : "file"} size={14} />
      <span className="agent-tool-label"><span>{label.action}</span>{label.detail && <code title={label.detail}>{label.detail}</code>}</span>
      {failed && <small role="status">Failed</small>}
      {!failed && (item.status === "in_progress" || item.status === "running") && <small role="status">Running</small>}
    </header>
    <div className="agent-tool-body">
      {item.input && <details className="agent-tool-input"><summary>Input</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details>}
      {!!item.content?.length && <AgentToolResult content={item.content} />}
      {item.text && !item.content?.length && <pre>{item.text}</pre>}
      {output?.exitCode !== undefined && <p className="agent-tool-exit">Exit code: {String(output.exitCode)}</p>}
      {item.output !== undefined && item.output !== null && <details className="agent-tool-input"><summary>Raw output</summary><pre>{JSON.stringify(item.output, null, 2) ?? String(item.output)}</pre></details>}
      {!item.content?.length && !item.text && !item.input && <p>No additional details supplied.</p>}
    </div>
  </article>
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
  // A new chunk or an assistant update is not the end of a turn. Every activity
  // group after the current user message stays active until the turn finishes.
  for (let index = lastUserIndex + 1; index < groups.length; index++) {
    const group = groups[index]
    if (group.kind === "activity-group") group.active = turnActive
  }
  return <>{groups.map(group => {
    if (group.kind === "activity-group") return <Activity key={group.id} group={group} />
    if (group.kind === "notice") return <p className={`agent-notice ${group.status === "error" ? "is-error" : ""}`} data-timeline-id={group.id} key={group.id}>{group.title && <strong>{group.title}: </strong>}{group.text}</p>
    if (group.kind === "tool") return <ToolRow key={group.id} item={group} />
    if (group.kind === "request") return requests?.expandedId === group.id ? <div key={group.id} data-timeline-id={group.id} className="agent-request-placeholder">Request opened in expanded view</div> : <AgentRequest key={group.id} item={group} actions={requests} />
    return <Message key={group.id} item={group} author={group.kind === "user" ? group.source === "parentAgent" ? "Parent agent" : "You" : agentName} agentId={agentId || agentName} actions={actions} />
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
  const chunks: TranscriptItem[][] = []
  for (let index = 0; index < group.items.length; index += 5) chunks.push(group.items.slice(index, index + 5))
  return <ActivityLayout group={group} chunks={chunks} layout="timeline" />
}

function ActivityLayout({ group, chunks, layout }: { group: ActivityGroup; chunks: TranscriptItem[][]; layout: "chapters" | "timeline" | "split" }) {
  return <div className={`agent-activity-layout agent-activity-layout--${layout}`} data-timeline-id={group.id}>
    {chunks.map((items, index) => <ActivityBlock key={`${items[0]?.id || group.id}:${index}`} group={group} items={items} />)}
  </div>
}

function ActivityBlock({ group, items }: { group: ActivityGroup; items: TranscriptItem[] }) {
  const failed = group.failed || items.some(item => item.status === "failed" || item.status === "error")
  const unfinished = items.some(item => item.kind === "tool" && !["completed", "failed", "error", "cancelled", "interrupted"].includes(item.status || ""))
  const autoExpanded = group.active || failed || unfinished
  const [expanded, setExpanded] = useState(autoExpanded)
  const wasAutoExpanded = useRef(autoExpanded)
  const rail = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const contentId = useId()
  useEffect(() => {
    // Auto-collapse only on a lifecycle transition, never on new chunks or
    // rerenders. A reader can reopen finished activity without it closing again.
    if (wasAutoExpanded.current !== autoExpanded) {
      if (!autoExpanded && content.current?.contains(document.activeElement)) rail.current?.focus({ preventScroll: true })
      setExpanded(autoExpanded)
    }
    wasAutoExpanded.current = autoExpanded
  }, [autoExpanded])
  const lastTool = [...items].reverse().find(item => item.kind === "tool")
  const label = lastTool ? toolLabel(lastTool) : undefined
  const summary = label
    ? [label.action, label.detail].filter(Boolean).join(" · ")
    : items.find(item => item.kind === "reasoning")?.text.replace(/\s+/g, " ").trim().slice(0, 160) || "Agent activity"
  const toggle = () => {
    // The collapsed summary is removed on expand; keep keyboard focus on the
    // persistent rail instead of dropping it back to the document.
    if (!expanded) rail.current?.focus({ preventScroll: true })
    setExpanded(value => !value)
  }
  return <section className={`agent-activity-block ${expanded ? "is-expanded" : "is-collapsed"}${failed ? " is-failed" : ""}`} data-timeline-id={`activity:${group.id}:${items[0]?.id || "empty"}`}>
    <button ref={rail} type="button" className={`agent-activity-rail${expanded ? " is-open" : ""}`} aria-label={`${expanded ? "Collapse" : "Expand"} activity: ${summary}`} aria-expanded={expanded} aria-controls={contentId} onClick={toggle}><span aria-hidden="true" /></button>
    <div className="agent-activity-content">
      {!expanded && <button type="button" className="agent-activity-summary" aria-expanded={false} aria-controls={contentId} aria-label={`Expand activity: ${summary}`} title={summary} onClick={toggle}><AgentIcon name="chevron" size={12} /><span>{summary}</span></button>}
      <div ref={content} id={contentId} hidden={!expanded}>
        {expanded && <div className="agent-activity-event-list">{items.map(item => item.kind === "reasoning"
          ? <section className="agent-activity-reasoning" key={item.id}><h3>Reasoning</h3><AgentMessage text={item.text} /></section>
          : <ToolRow key={item.id} item={item} />)}</div>}
      </div>
    </div>
  </section>
}
