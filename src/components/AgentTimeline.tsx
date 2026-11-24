import { memo, useEffect, useId, useRef, useState } from "react"
import { splitErrorText } from "../bridge/errors"
import { toolLabel, type TranscriptItem } from "../agents/transcript"
import type { AgentHistoryCapabilities, AgentPlanEntry } from "../agents/types"
import AgentIcon from "./AgentIcon"
import { AgentMessage, AgentToolResult } from "./AgentMessage"
import AgentDisclosure from "./AgentDisclosure"
import AgentProviderMark from "./AgentProviderMark"
import AgentRequest, { type AgentRequestActions } from "./AgentRequest"

type ActivityGroup = { kind: "activity-group"; id: string; items: TranscriptItem[]; failed: boolean; active: boolean }
type TimelineGroup = TranscriptItem | ActivityGroup

function ToolRow({ item, collapsed = false }: { item: TranscriptItem; collapsed?: boolean }) {
  const label = toolLabel(item)
  const output = item.output && typeof item.output === "object" ? item.output as Record<string, unknown> : undefined
  const failed = item.status === "failed" || item.status === "error"
  const heading = <><AgentIcon name={failed ? "file" : label.kind === "execute" ? "terminal" : label.kind === "search" ? "search" : label.kind === "edit" ? "edit" : "file"} size={14} />
      <span className="agent-tool-label"><span>{label.action}</span>{label.detail && <code title={label.detail}>{label.detail}</code>}</span>
      {failed && <small role="status">Failed</small>}
      {!failed && (item.status === "in_progress" || item.status === "running") && <small role="status">Running</small>}
      {collapsed && <AgentIcon name="chevron" size={12} />}</>
  const body = <div className="agent-tool-body">
      {item.previewTruncated && <p className="agent-muted">Output preview shortened. Full output remains in saved history; partial edits are not shown as complete diffs.</p>}
      {item.input && <details className="agent-tool-input"><summary>Input</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details>}
      {!!item.content?.length && !item.previewTruncated && <AgentToolResult content={item.content} />}
      {item.text && !item.content?.length && <pre>{item.text}</pre>}
      {output?.exitCode !== undefined && <p className="agent-tool-exit">Exit code: {String(output.exitCode)}</p>}
      {item.output !== undefined && item.output !== null && <details className="agent-tool-input"><summary>Raw output</summary><pre>{JSON.stringify(item.output, null, 2) ?? String(item.output)}</pre></details>}
      {!item.content?.length && !item.text && !item.input && <p>No additional details supplied.</p>}
    </div>
  const className = `agent-tool agent-tool--inline ${failed ? "is-failed" : ""}`
  return collapsed
    ? <details className={className} data-timeline-id={`detail:${item.id}`}><summary className="agent-tool-heading">{heading}</summary>{body}</details>
    : <article className={className} data-timeline-id={`detail:${item.id}`}><header className="agent-tool-heading">{heading}</header>{body}</article>
}
function ErrorNotice({ item, repeat }: { item: TranscriptItem; repeat: number }) {
  const failure = splitErrorText(item.text)
  return <div className="agent-notice is-error" data-timeline-id={item.id}>
    <div className="agent-notice-summary"><span className="agent-notice-mark" aria-hidden="true" /><span className="agent-notice-line-text">{item.title && <strong>{item.title}: </strong>}{failure.summary}</span>{repeat > 1 && <span className="agent-notice-repeat" aria-label={`Repeated ${repeat} times`}>×{repeat}</span>}</div>
    {failure.detail && <details className="agent-notice-details"><summary>Details</summary><pre tabIndex={0}>{failure.detail}</pre></details>}
  </div>
}
type MessageActions = { capabilities?: AgentHistoryCapabilities; enabled: boolean; act: (message: TranscriptItem, retry: boolean) => void }
export const AgentTimeline = memo(function AgentTimeline({ items, agentName, agentId, plan, actions, requests, turnActive = false }: { items: TranscriptItem[]; agentName: string; agentId?: string; plan?: AgentPlanEntry[]; actions?: MessageActions; requests?: AgentRequestActions; turnActive?: boolean }) {
  const groups: TimelineGroup[] = []
  const repeats = new Map<string, number>()
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
    const previous = groups[groups.length - 1]
    // A provider that repeats the same failure should not repeat the same line.
    if (item.kind === "notice" && previous?.kind === "notice" && previous.status === item.status && previous.title === item.title && previous.text === item.text) { repeats.set(previous.id, (repeats.get(previous.id) || 1) + 1); continue }
    groups.push(item)
  }
  const lastUserIndex = groups.reduce((last, group, index) => group.kind === "user" ? index : last, -1)
  // A new chunk or an assistant update is not the end of a turn. Every activity
  // group after the current user message stays active until the turn finishes.
  for (let index = lastUserIndex + 1; index < groups.length; index++) {
    const group = groups[index]
    if (group.kind === "activity-group") group.active = turnActive
  }
  // Failed groups stay collapsed: the summary already says "N failed". Only live work opens itself.
  const automaticGroup = groups.slice(lastUserIndex + 1).reverse().find(group => group.kind === "activity-group" && (
    group.active || group.items.some(item => item.kind === "tool" && !["completed", "failed", "error", "cancelled", "interrupted"].includes(item.status || ""))
  ))
  const automaticGroupId = automaticGroup?.id || null
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(automaticGroupId)
  useEffect(() => { setExpandedActivityId(automaticGroupId) }, [automaticGroupId])
  return <>{groups.map(group => {
    if (group.kind === "activity-group") return <Activity key={group.id} group={group} expanded={expandedActivityId === group.id} onToggle={() => setExpandedActivityId(value => value === group.id ? null : group.id)} />
    if (group.kind === "notice") return group.status === "error" ? <ErrorNotice key={group.id} item={group} repeat={repeats.get(group.id) || 1} />
      : <p className="agent-notice" data-timeline-id={group.id} key={group.id}>{group.title && <strong>{group.title}: </strong>}{group.text}</p>
    if (group.kind === "tool") return <ToolRow key={group.id} item={group} />
    if (group.kind === "request") return requests?.expandedId === group.id ? <div key={group.id} data-timeline-id={group.id} className="agent-request-placeholder">Request opened in expanded view</div> : <AgentRequest key={group.id} item={group} actions={requests} />
    return <Message key={group.id} item={group} author={group.kind === "user" ? group.source === "parentAgent" ? "Parent agent" : "You" : agentName} agentId={agentId || agentName} actions={actions} />
  })}
    {!!plan?.length && <AgentDisclosure className="agent-plan" summary={<><AgentIcon name="check" size={14} /><span>Plan</span><small>{plan.filter(entry => entry.status === "completed").length} of {plan.length} complete</small><AgentIcon name="chevron" size={12} /></>}><ol>{plan.map((entry, index) => <li key={index} className={entry.status}><span>{entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "•" : "○"}</span>{entry.content}</li>)}</ol></AgentDisclosure>}
  </>
})
const Message = memo(function Message({ item, author, agentId, actions }: { item: TranscriptItem; author: string; agentId: string; actions?: MessageActions }) {
  const { id, kind, text } = item
  const canAct = kind === "user" && !item.previewTruncated && item.messageId && item.checkpoint && actions
  return <article data-timeline-id={id} className={`agent-message agent-message-${kind}`}><div className="agent-message-author">{kind !== "user" && <AgentProviderMark id={agentId} size={19} />}{author}</div>{kind === "user" ? <p className="agent-user-text">{text}</p> : <AgentMessage text={text} />}
    {canAct && (actions.capabilities?.revert || actions.capabilities?.retry) && <div className="agent-message-actions" aria-label="Message actions">
      {actions.capabilities?.revert && <button type="button" disabled={!actions.enabled} title="Return to before this message; files stay as they are" onClick={() => actions.act(item, false)}><AgentIcon name="back" size={13} />Revert</button>}
      {actions.capabilities?.retry && <button type="button" disabled={!actions.enabled} title="Revert this message and later replies, then send it again with the selected model" onClick={() => actions.act(item, true)}><AgentIcon name="refresh" size={13} />Retry</button>}
    </div>}
  </article>
}, (before, after) => before.item.id === after.item.id && before.item.kind === after.item.kind && before.item.text === after.item.text && before.item.messageId === after.item.messageId && before.item.checkpoint === after.item.checkpoint && before.author === after.author && before.agentId === after.agentId && before.actions === after.actions)
type ActivityBatch = { items: TranscriptItem[]; groups: number }
function Activity({ group, expanded, onToggle }: { group: ActivityGroup; expanded: boolean; onToggle: () => void }) {
  let batches: ActivityBatch[] = []
  for (let index = 0; index < group.items.length; index += 5) batches.push({ items: group.items.slice(index, index + 5), groups: 1 })
  while (batches.length > 1) {
    const parents: ActivityBatch[] = []
    for (let index = 0; index < batches.length; index += 5) {
      const children = batches.slice(index, index + 5)
      parents.push({ items: children.flatMap(child => child.items), groups: children.reduce((count, child) => count + child.groups, 0) })
    }
    batches = parents
  }
  const root = batches[0]
  return <div className="agent-activity-layout agent-activity-layout--timeline" data-timeline-id={group.id}>
    {root && <ActivityBlock group={group} items={root.items} groupCount={root.groups} expanded={expanded} onToggle={onToggle} />}
  </div>
}

function ActivityBlock({ group, items, groupCount, expanded, onToggle }: { group: ActivityGroup; items: TranscriptItem[]; groupCount: number; expanded: boolean; onToggle: () => void }) {
  const failedCount = items.filter(item => item.kind === "tool" && (item.status === "failed" || item.status === "error")).length || (group.failed ? 1 : 0)
  const failed = failedCount > 0
  const handoff = useRef(false)
  const rail = useRef<HTMLButtonElement>(null)
  const summaryButton = useRef<HTMLButtonElement>(null)
  const contentId = useId()
  // The rail only exists while expanded and the summary only while collapsed, so
  // keyboard focus moves to the control that exists after the toggle has rendered.
  useEffect(() => {
    if (!handoff.current) return
    handoff.current = false
    ;(expanded ? rail.current : summaryButton.current)?.focus({ preventScroll: true })
  }, [expanded])
  const lastTool = [...items].reverse().find(item => item.kind === "tool")
  const label = lastTool ? toolLabel(lastTool) : undefined
  const activitySummary = label
    ? [label.action, label.detail].filter(Boolean).join(" · ")
    : items.find(item => item.kind === "reasoning")?.text.replace(/\s+/g, " ").trim().slice(0, 160) || "Agent activity"
  const groupedSummary = groupCount > 1 ? `${groupCount} activity groups · ${activitySummary}` : activitySummary
  const summary = failed ? `${failedCount} failed · ${groupedSummary}` : groupedSummary
  const toggle = () => { handoff.current = true; onToggle() }
  return <section className={`agent-activity-block ${expanded ? "is-expanded" : "is-collapsed"}${failed ? " is-failed" : ""}`} data-timeline-id={`activity:${group.id}:${items[0]?.id || "empty"}`}>
    <button ref={rail} type="button" className={`agent-activity-rail${expanded ? " is-open" : ""}`} aria-label={`${expanded ? "Collapse" : "Expand"} activity: ${summary}`} aria-expanded={expanded} aria-controls={contentId} onClick={toggle}><span aria-hidden="true" /></button>
    <div className="agent-activity-content">
      {!expanded && <button ref={summaryButton} type="button" className="agent-activity-summary" aria-expanded={false} aria-controls={contentId} aria-label={`Expand activity: ${summary}`} title={summary} onClick={toggle}><AgentIcon name="chevron" size={12} />{failed && <i className="agent-activity-fail-dot" aria-hidden="true" />}<span>{summary}</span></button>}
      <div id={contentId} hidden={!expanded}>
        {expanded && <div className="agent-activity-event-list">{items.map(item => item.kind === "reasoning"
          ? <details className="agent-activity-reasoning" data-timeline-id={`detail:${item.id}`} key={item.id}><summary><AgentIcon name="chevron" size={12} /><h3>Reasoning</h3></summary><div className="agent-activity-reasoning-body"><AgentMessage text={item.text} /></div></details>
          : <ToolRow key={item.id} item={item} collapsed />)}</div>}
      </div>
    </div>
  </section>
}
