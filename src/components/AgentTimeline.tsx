import { useState } from "react"
import { toolLabel, type TranscriptItem } from "../agents/transcript"
import type { AgentInputRequest, AgentPermissionRequest, AgentPlanEntry } from "../agents/types"
import AgentIcon from "./AgentIcon"
import { AgentMessage, AgentToolResult } from "./AgentMessage"

function ToolRow({ item }: { item: TranscriptItem }) {
  const label = toolLabel(item)
  const output = item.output && typeof item.output === "object" ? item.output as Record<string, unknown> : undefined
  const succeeded = item.status === "completed", failed = item.status === "failed" || item.status === "error"
  return <details className={`agent-tool ${failed ? "is-failed" : ""}`}>
    <summary><AgentIcon name={succeeded ? "check" : label.kind === "execute" ? "terminal" : label.kind === "search" ? "search" : label.kind === "edit" ? "edit" : "file"} size={14} />
      <span className="agent-tool-label">{label.action}{label.detail && <code>{label.detail}</code>}</span>
      <small>{failed ? "Failed" : succeeded ? "Done" : item.status === "in_progress" || item.status === "running" ? "Running" : item.status === "cancelled" || item.status === "interrupted" ? "Stopped" : "Pending"}</small><AgentIcon name="chevron" size={12} /></summary>
    <div className="agent-tool-body">
      {item.input && <details className="agent-tool-input"><summary>Input</summary><pre>{JSON.stringify(item.input, null, 2)}</pre></details>}
      {!!item.content?.length && <AgentToolResult content={item.content} />}
      {item.text && !item.content?.length && <pre>{item.text}</pre>}
      {output?.exitCode !== undefined && <p className="agent-tool-exit">Exit code: {String(output.exitCode)}</p>}
      {!item.content?.length && !item.text && !item.input && <p>No additional details supplied.</p>}
    </div>
  </details>
}
export function AgentTimeline({ items, agentName, plan }: { items: TranscriptItem[]; agentName: string; plan?: AgentPlanEntry[] }) {
  const groups: Array<TranscriptItem | TranscriptItem[]> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (item.kind === "tool" && item.status === "completed") {
      if (Array.isArray(last)) last.push(item); else groups.push([item])
    } else groups.push(item)
  }
  return <>{groups.map((item, index) => Array.isArray(item) ? item.length === 1 ? <ToolRow key={item[0].id} item={item[0]} /> : <details key={item[0].id} className="agent-work-group"><summary><AgentIcon name="check" size={14} /><span>{item.length} operations completed</span><AgentIcon name="chevron" size={12} /></summary>{item.map(tool => <ToolRow key={tool.id} item={tool} />)}</details>
    : item.kind === "notice" ? <p className="agent-notice" key={item.id}>{item.text}</p> : item.kind === "tool" ? <ToolRow key={item.id} item={item} />
      : item.kind === "reasoning" ? <details key={item.id} className="agent-reasoning"><summary>Reasoning <AgentIcon name="chevron" size={12} /></summary><AgentMessage text={item.text} /></details>
        : <article key={`${item.id}-${index}`} className={`agent-message agent-message-${item.kind}`}><div className="agent-message-author">{item.kind === "user" ? "You" : agentName}</div>{item.kind === "user" ? <p className="agent-user-text">{item.text}</p> : <AgentMessage text={item.text} />}</article>)}
    {!!plan?.length && <details className="agent-plan"><summary><AgentIcon name="check" size={14} /><span>Plan</span><small>{plan.filter(entry => entry.status === "completed").length} of {plan.length} complete</small><AgentIcon name="chevron" size={12} /></summary><ol>{plan.map((entry, index) => <li key={index} className={entry.status}><span>{entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "•" : "○"}</span>{entry.content}</li>)}</ol></details>}
  </>
}
export function PermissionCard({ request, busy, respond }: { request: AgentPermissionRequest; busy: boolean; respond: (option: string) => void }) {
  return <section className="agent-permission" aria-label="Pending approval"><div><span className="agent-status-dot attention" /><strong>Approval needed</strong></div><h2>{request.title}</h2>
    {request.description && <p>{request.description}</p>}{request.command && <pre>{request.command}</pre>}
    {!!request.content?.length && <AgentToolResult content={request.content} />}
    {request.rawInput && <details className="agent-tool-input"><summary>Operation details</summary><pre>{JSON.stringify(request.rawInput, null, 2)}</pre></details>}
    <div className="agent-inline-actions">{request.options.map(option => <button type="button" key={option.optionId} disabled={busy} className={option.kind === "allow_once" ? "agent-primary" : "agent-button"} onClick={() => respond(option.optionId)}>{option.name}</button>)}</div>
  </section>
}
export function InputCard({ request, busy, respond }: { request: AgentInputRequest; busy: boolean; respond: (answers: Record<string, unknown> | null) => void }) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  return <form className="agent-question" aria-label="Agent question" onSubmit={e => { e.preventDefault(); respond(answers) }}><h2>{request.title}</h2>
    {Object.entries(request.schema.properties || {}).map(([id, field]) => {
      const choices = field.oneOf?.map(option => ({ value: option.const, name: option.title || option.const })) || field.enum?.map(value => ({ value, name: value }))
      return <label className="agent-field" key={id}>{field.title || id}{field.description && <span>{field.description}</span>}
        {field.type === "array" && field.items?.enum ? <select multiple aria-label={field.title || id} required={request.schema.required?.includes(id)} value={Array.isArray(answers[id]) ? answers[id] as string[] : []} onChange={e => setAnswers(all => ({ ...all, [id]: [...e.target.selectedOptions].map(option => option.value) }))}>{field.items.enum.map(value => <option value={value} key={value}>{value}</option>)}</select>
          : field.type === "boolean" ? <input type="checkbox" aria-label={field.title || id} checked={answers[id] === true} onChange={e => setAnswers(all => ({ ...all, [id]: e.target.checked }))} />
          : choices ? <select aria-label={field.title || id} required={request.schema.required?.includes(id)} value={String(answers[id] || "")} onChange={e => setAnswers(all => ({ ...all, [id]: e.target.value }))}><option value="">Choose…</option>{choices.map(option => <option value={option.value} key={option.value}>{option.name}</option>)}</select>
          : <input type={field.type === "number" || field.type === "integer" ? "number" : "text"} aria-label={field.title || id} required={request.schema.required?.includes(id)} value={String(answers[id] ?? "")} onChange={e => setAnswers(all => ({ ...all, [id]: field.type === "number" || field.type === "integer" ? e.target.valueAsNumber : e.target.value }))} />}</label>
    })}
    <div className="agent-inline-actions"><button className="agent-primary" disabled={busy} type="submit">Continue</button><button className="agent-button" disabled={busy} type="button" onClick={() => respond(null)}>Dismiss</button></div>
  </form>
}
