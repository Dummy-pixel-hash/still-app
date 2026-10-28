import { memo } from "react"
import { toolLabel, type TranscriptItem } from "../agents/transcript"
import type { AgentHistoryCapabilities, AgentPlanEntry } from "../agents/types"
import AgentIcon from "./AgentIcon"
import { AgentMessage, AgentToolResult } from "./AgentMessage"
import AgentDisclosure from "./AgentDisclosure"
import AgentProviderMark from "./AgentProviderMark"
import AgentRequest, { type AgentRequestActions } from "./AgentRequest"

function ToolRow({ item }: { item: TranscriptItem }) {
  const label = toolLabel(item)
  const output = item.output && typeof item.output === "object" ? item.output as Record<string, unknown> : undefined
  const succeeded = item.status === "completed", failed = item.status === "failed" || item.status === "error"
  return <AgentDisclosure id={`detail:${item.id}`} className={`agent-tool ${failed ? "is-failed" : ""}`} summary={<><AgentIcon name={succeeded ? "check" : label.kind === "execute" ? "terminal" : label.kind === "search" ? "search" : label.kind === "edit" ? "edit" : "file"} size={14} />
      <span className="agent-tool-label">{label.action}{label.detail && <code>{label.detail}</code>}</span>
      <small>{failed ? "Failed" : succeeded ? "Done" : item.status === "in_progress" || item.status === "running" ? "Running" : item.status === "cancelled" || item.status === "interrupted" ? "Stopped" : "Pending"}</small><AgentIcon name="chevron" size={12} /></>}>
    <div className="agent-tool-body">
      {item.input && <details className="agent-tool-input"><summary>Input</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details>}
      {!!item.content?.length && <AgentToolResult content={item.content} />}
      {item.text && !item.content?.length && <pre>{item.text}</pre>}
      {output?.exitCode !== undefined && <p className="agent-tool-exit">Exit code: {String(output.exitCode)}</p>}
      {!item.content?.length && !item.text && !item.input && <p>No additional details supplied.</p>}
    </div>
    </AgentDisclosure>
}
type MessageActions = { capabilities?: AgentHistoryCapabilities; enabled: boolean; act: (message: TranscriptItem, retry: boolean) => void }
export const AgentTimeline = memo(function AgentTimeline({ items, agentName, agentId, plan, actions, requests }: { items: TranscriptItem[]; agentName: string; agentId?: string; plan?: AgentPlanEntry[]; actions?: MessageActions; requests?: AgentRequestActions }) {
  const groups: Array<TranscriptItem | TranscriptItem[]> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (item.kind === "tool") {
      if (Array.isArray(last)) last.push(item); else groups.push([item])
    } else groups.push(item)
  }
  return <>{groups.map(item => Array.isArray(item) ? <ToolGroup key={item[0].id} items={item} />
    : item.kind === "notice" ? <p className={`agent-notice ${item.status === "error" ? "is-error" : ""}`} data-timeline-id={item.id} key={item.id}>{item.title && <strong>{item.title}: </strong>}{item.text}</p> : item.kind === "tool" ? <ToolRow key={item.id} item={item} />
      : item.kind === "request" ? requests?.expandedId === item.id ? <div key={item.id} data-timeline-id={item.id} className="agent-request-placeholder">Request opened in expanded view</div> : <AgentRequest key={item.id} item={item} actions={requests} />
      : item.kind === "reasoning" ? <AgentDisclosure key={item.id} id={item.id} className="agent-reasoning" summary={<>Reasoning <AgentIcon name="chevron" size={12} /></>}><AgentMessage text={item.text} /></AgentDisclosure>
        : <Message key={item.id} item={item} author={item.kind === "user" ? "You" : agentName} agentId={agentId || agentName} actions={actions} />)}
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
function ToolGroup({ items }: { items: TranscriptItem[] }) {
  const done = items.filter(item => item.status === "completed").length
  const failed = items.some(item => item.status === "failed" || item.status === "error")
  const active = items.some(item => item.status === "running" || item.status === "in_progress")
  const stopped = items.some(item => item.status === "cancelled" || item.status === "interrupted")
  const label = items.length === 1 ? toolLabel(items[0]) : null
  return <AgentDisclosure id={items[0].id} className={`agent-work-group ${failed ? "is-failed" : ""}`} summary={<><AgentIcon name={done === items.length ? "check" : "terminal"} size={15} /><span className="agent-tool-label">{label?.action || `${items.length} operations`}{label?.detail && <code>{label.detail}</code>}</span><small>{failed ? "Needs attention" : active ? "Working" : stopped ? "Stopped" : done === items.length ? "Completed" : "Pending"}</small><AgentIcon name="chevron" size={12} /></>}><div className="agent-work-group-body">{items.map(item => <ToolRow key={item.id} item={item} />)}</div></AgentDisclosure>
}
