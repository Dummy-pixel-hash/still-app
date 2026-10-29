import { memo } from "react"
import { toolLabel, type TranscriptItem } from "../agents/transcript"
import type { AgentHistoryCapabilities, AgentPlanEntry } from "../agents/types"
import AgentIcon from "./AgentIcon"
import { AgentMessage, AgentToolResult } from "./AgentMessage"
import AgentDisclosure from "./AgentDisclosure"
import AgentProviderMark from "./AgentProviderMark"
import AgentRequest, { type AgentRequestActions } from "./AgentRequest"
import LatticeLoader from "./LatticeLoader"

type ReasoningGroup = { kind: "reasoning-group"; id: string; items: TranscriptItem[]; failed: boolean }
type TimelineGroup = TranscriptItem | TranscriptItem[] | ReasoningGroup

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
export const AgentTimeline = memo(function AgentTimeline({ items, agentName, agentId, plan, actions, requests, turnActive = false }: { items: TranscriptItem[]; agentName: string; agentId?: string; plan?: AgentPlanEntry[]; actions?: MessageActions; requests?: AgentRequestActions; turnActive?: boolean }) {
  const groups: TimelineGroup[] = []
  let reasoning: ReasoningGroup | undefined
  let tools: TranscriptItem[] | undefined
  for (const item of items) {
    if (item.kind === "reasoning") {
      tools = undefined
      if (!reasoning) {
        reasoning = { kind: "reasoning-group", id: item.id, items: [], failed: false }
        groups.push(reasoning)
      }
      reasoning.items.push(item)
      continue
    }
    if (item.kind === "tool") {
      // A tool call closes the current thought. Any later reasoning belongs to
      // a new, separately ordered activity marker after the stacked tool group.
      reasoning = undefined
      if (!tools) { tools = []; groups.push(tools) }
      tools.push(item)
      continue
    }
    if (item.kind === "notice" && item.status === "error" && reasoning) reasoning.failed = true
    tools = undefined
    if (["user", "assistant", "request", "notice"].includes(item.kind)) reasoning = undefined
    groups.push(item)
  }
  let lastUserIndex = -1, lastReasoningIndex = -1
  groups.forEach((group, index) => {
    if (!Array.isArray(group) && group.kind === "user") lastUserIndex = index
    if (!Array.isArray(group) && group.kind === "reasoning-group") lastReasoningIndex = index
  })
  const activeReasoningIndex = turnActive && lastReasoningIndex === groups.length - 1 && (lastUserIndex < 0 || lastReasoningIndex > lastUserIndex) ? lastReasoningIndex : -1
  return <>{groups.map((group, index) => {
    if (Array.isArray(group)) return <ToolGroup key={group[0].id} items={group} />
    if (group.kind === "reasoning-group") {
      const status = group.failed ? "error" : index === activeReasoningIndex ? "working" : "done"
      const label = status === "working" ? "Thinking" : status === "error" ? "Interrupted" : "Thought"
      return <div key={group.id} className="agent-reasoning" data-timeline-id={group.id}>
        <LatticeLoader className="agent-reasoning-loader" label={label} doneLabel="Thought" errorLabel="Interrupted" status={status} pattern="orbit" grid={3} cellSize={4} gap={2} showTimer={false} announce={index === activeReasoningIndex} />
        {group.items.length > 1 && <span className="agent-reasoning-phases">{group.items.length} passes</span>}
      </div>
    }
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
function ToolGroup({ items }: { items: TranscriptItem[] }) {
  const done = items.filter(item => item.status === "completed").length
  const failed = items.some(item => item.status === "failed" || item.status === "error")
  const active = items.some(item => item.status === "running" || item.status === "in_progress")
  const stopped = items.some(item => item.status === "cancelled" || item.status === "interrupted")
  const label = items.length === 1 ? toolLabel(items[0]) : null
  return <AgentDisclosure id={items[0].id} className={`agent-work-group ${failed ? "is-failed" : ""}`} summary={<><AgentIcon name={done === items.length ? "check" : "terminal"} size={15} /><span className="agent-tool-label">{label?.action || `${items.length} operations`}{label?.detail && <code>{label.detail}</code>}</span><small>{failed ? "Needs attention" : active ? "Working" : stopped ? "Stopped" : done === items.length ? "Completed" : "Pending"}</small><AgentIcon name="chevron" size={12} /></>}><div className="agent-work-group-body">{items.map(item => <ToolRow key={item.id} item={item} />)}</div></AgentDisclosure>
}
