import { useId, useLayoutEffect, useRef, useState } from "react"
import type { AgentInputField, AgentInputRequest, AgentPermissionRequest } from "../agents/types"
import type { TranscriptItem } from "../agents/transcript"
import { inputChoices, questionFields, validateAnswers } from "../agents/requests"
import AgentIcon from "./AgentIcon"
import { AgentToolResult } from "./AgentMessage"

export type AgentRequestActions = {
  activeKey?: string
  busy: boolean
  keyFor: (item: TranscriptItem) => string
  answersFor: (key: string, request: AgentInputRequest) => Record<string, unknown>
  errorFor: (key: string) => string | undefined
  updateAnswers: (key: string, answers: Record<string, unknown>) => void
  answer: (item: TranscriptItem, answers: Record<string, unknown> | null) => void
  permission: (item: TranscriptItem, optionId: string) => void
  reconcile: (item: TranscriptItem) => void
  expand: (id: string | null) => void
  expandedId: string | null
  available: boolean
}

export function requestOutcomeLabel(item: TranscriptItem) {
  switch (item.requestOutcome?.outcome) {
    case "answered": return "Answer sent"
    case "dismissed": return "Question dismissed"
    case "approved": return "Approval sent"
    case "rejected": return "Request rejected"
    case "cancelled": return "Request cancelled"
    default: return "No longer active"
  }
}

export default function AgentRequest({ item, actions, expanded = false }: { item: TranscriptItem; actions?: AgentRequestActions; expanded?: boolean }) {
  const titleId = useId(), root = useRef<HTMLElement>(null)
  const kind = item.requestKind || "question", key = actions?.keyFor(item) || ""
  const active = !!actions && actions.activeKey === key && !item.requestOutcome
  const submitting = active && actions.busy
  const error = actions?.errorFor(key)
  const status = active ? submitting ? "Sending response…" : kind === "permission" ? "Approval needed" : "Needs your answer" : requestOutcomeLabel(item)
  const previous = useRef(document.activeElement as HTMLElement | null)
  useLayoutEffect(() => {
    if (!expanded) return
    root.current?.querySelector<HTMLButtonElement>('[aria-label="Close expanded request"]')?.focus({ preventScroll: true })
    return () => {
      const target = previous.current
      requestAnimationFrame(() => { if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true }) })
    }
  }, [expanded])
  const readOnly = !actions?.available || submitting || !!error
  return <section ref={root} className={`agent-request-card agent-request-${kind} ${active ? "is-active" : "is-resolved"} ${expanded ? "is-expanded agent-modal" : ""}`} role={expanded ? "dialog" : "region"} aria-modal={expanded || undefined} aria-labelledby={titleId} data-timeline-id={expanded ? undefined : item.id} data-request-status={active ? "pending" : item.requestOutcome?.outcome || "inactive"} onKeyDown={event => {
    if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); actions?.expand(null) }
  }}>
    <div className="agent-request-heading"><span className={`agent-request-mark ${kind === "permission" ? "is-approval" : "is-question"}`} aria-hidden="true"><AgentIcon name={kind === "permission" ? "terminal" : "chat"} size={16} /></span><div><span>{status}</span><h2 id={titleId}>{item.title || "Agent request"}</h2></div>{actions && (expanded ? <button type="button" className="agent-icon-button" aria-label="Close expanded request" onClick={() => actions.expand(null)}><AgentIcon name="close" size={16} /></button> : active && <button type="button" className="agent-request-expand" aria-haspopup="dialog" onClick={() => actions.expand(item.id)}>Expand request<AgentIcon name="expand" size={13} /></button>)}</div>
    {active && actions && item.permission ? <PermissionContent request={item.permission} disabled={readOnly} error={error} busy={submitting} respond={option => actions.permission(item, option)} reconcile={() => actions.reconcile(item)} />
      : active && actions && item.agentInput ? <QuestionContent request={item.agentInput} disabled={readOnly} busy={submitting} error={error} answers={actions.answersFor(key, item.agentInput)} update={answers => actions.updateAnswers(key, answers)} respond={answers => actions.answer(item, answers)} reconcile={() => actions.reconcile(item)} />
        : <div className="agent-request-result"><AgentIcon name={item.requestOutcome && item.requestOutcome.outcome !== "uncertain" ? "check" : "chat"} size={14} /><p>{item.requestOutcome ? item.requestOutcome.outcome === "approved" ? `Your choice was sent${item.requestOutcome.responseLabel ? ` · ${item.requestOutcome.responseLabel}` : ""}.` : item.requestOutcome.outcome === "answered" ? "Your answer was sent to the agent." : item.requestOutcome.outcome === "dismissed" ? "You dismissed this question." : item.requestOutcome.outcome === "rejected" ? "You rejected this operation." : item.requestOutcome.outcome === "cancelled" ? "This request was cancelled with the agent turn." : "The response was not confirmed. Check the agent’s session before continuing." : "This historical request is no longer active. No response was recorded."}</p></div>}
    {active && !actions?.available && <p className="agent-request-unavailable">Reconnect this conversation’s server before responding.</p>}
  </section>
}

function RequestError({ error, reconcile, busy }: { error?: string; reconcile: () => void; busy: boolean }) {
  if (!error) return null
  return <div className="agent-request-error" role="alert"><p>{error}</p><button className="agent-button" type="button" disabled={busy} onClick={reconcile}>Check request status</button></div>
}

function PermissionContent({ request, disabled, error, busy, respond, reconcile }: { request: AgentPermissionRequest; disabled: boolean; error?: string; busy: boolean; respond: (option: string) => void; reconcile: () => void }) {
  const raw = request.rawInput
  const command = request.command || (typeof raw?.command === "string" ? raw.command : undefined)
  const resource = [raw?.path, raw?.file_path, raw?.url].find(value => typeof value === "string") as string | undefined
  const options = [...request.options].sort((a, b) => Number(b.kind.startsWith("reject")) - Number(a.kind.startsWith("reject")))
  return <>
    <div className="agent-request-body" tabIndex={0} role="region" aria-label="Requested operation">
      {request.description && <p>{request.description}</p>}
      {command ? <pre className="agent-request-command" aria-label="Requested command">{command}</pre> : resource ? <code className="agent-request-resource">{resource}</code> : null}
      {!!request.content?.length && <AgentToolResult content={request.content} />}
      {raw && <details className="agent-request-extra"><summary>Operation details</summary><pre>{JSON.stringify(raw, null, 2)}</pre></details>}
    </div>
    <RequestError error={error} busy={busy} reconcile={reconcile} />
    <div className="agent-request-actions">{options.map(option => <button type="button" key={option.optionId} disabled={disabled} className={option.kind === "allow_once" ? "agent-primary" : "agent-button"} onClick={() => respond(option.optionId)}>{option.name}</button>)}</div>
  </>
}

function ChoiceField({ id, field, number, required, answer, update, disabled, error, base }: { id: string; field: AgentInputField; number: number; required: boolean; answer: unknown; update: (answer: unknown) => void; disabled: boolean; error?: string; base: string }) {
  const [query, setQuery] = useState("")
  const multi = field.type === "array", options = inputChoices(multi ? field.items || {} : field)
  const filtered = options.filter(option => `${option.name} ${option.description || ""}`.toLowerCase().includes(query.toLowerCase()))
  const hint = `${base}-description`, errorId = `${base}-error`
  return <fieldset className="agent-question-group" data-question-group={id} disabled={disabled} aria-describedby={[field.description ? hint : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined}>
    <legend><span className="agent-question-number" aria-hidden="true">{number}</span>{field.title || id}<span className="agent-question-required">{required ? "Required" : "Optional"}</span></legend>
    {field.description && <p id={hint} className="agent-question-description">{field.description}</p>}
    {options.length > 8 && <input className="agent-choice-search" type="search" aria-label={`Search ${field.title || id} choices`} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an option…" />}
    <div className="agent-question-choices">{filtered.map(option => {
      const checked = multi ? Array.isArray(answer) && answer.includes(option.value) : answer === option.value
      return <label className={`agent-question-choice ${checked ? "is-selected" : ""}`} key={option.value}><input type={multi ? "checkbox" : "radio"} aria-label={option.name} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} name={base} value={option.value} checked={checked} onChange={() => update(multi ? checked ? (answer as string[]).filter(value => value !== option.value) : [...(Array.isArray(answer) ? answer : []), option.value] : option.value)} /><span>{option.name}{option.description && <small>{option.description}</small>}</span>{checked && <AgentIcon name="check" size={14} />}</label>
    })}{!filtered.length && <p className="agent-muted">No matching choices.</p>}</div>
    {error && <p className="agent-question-inline-error" id={errorId}>{error}</p>}
  </fieldset>
}

function QuestionContent({ request, disabled, busy, error, answers, update, respond, reconcile }: { request: AgentInputRequest; disabled: boolean; busy: boolean; error?: string; answers: Record<string, unknown>; update: (answers: Record<string, unknown>) => void; respond: (answers: Record<string, unknown> | null) => void; reconcile: () => void }) {
  const id = useId(), [errors, setErrors] = useState<Record<string, string>>({})
  const { fields, unsupported } = questionFields(request)
  const set = (key: string, answer: unknown) => { setErrors(old => { const next = { ...old }; delete next[key]; return next }); update({ ...answers, [key]: answer }) }
  return <form className="agent-question-form" aria-label="Agent question" noValidate onKeyDown={event => {
    if (event.key === "Enter" && !(event.target as HTMLElement).closest("textarea,button")) event.preventDefault()
  }} onSubmit={event => {
    event.preventDefault()
    if (disabled) return
    const result = validateAnswers(request, answers)
    setErrors(result.errors)
    if (result.unsupported) return
    const first = Object.keys(result.errors)[0]
    if (first) {
      const group = event.currentTarget.querySelector<HTMLElement>(`[data-question-group="${CSS.escape(first)}"]`)
      group?.querySelector<HTMLElement>('input:not([type="search"]),textarea,button')?.focus()
      return
    }
    respond(result.value)
  }}>
    <div className="agent-question-fields">
      {fields.map(([key, field], index) => {
        const title = field.title || key, required = request.schema.required?.includes(key) || false, base = `${id}-${index}`
        const hint = field.description ? `${base}-description` : undefined, errorId = errors[key] ? `${base}-error` : undefined
        const describedBy = [hint, errorId].filter(Boolean).join(" ") || undefined
        if (field.type === "array" || inputChoices(field).length) return <ChoiceField key={key} id={key} base={base} field={field} number={index + 1} required={required} answer={answers[key]} disabled={disabled} error={errors[key]} update={value => set(key, value)} />
        return <div data-question-group={key} className="agent-question-group" key={key}>
          <label className="agent-question-field-label" htmlFor={base}><span className="agent-question-number" aria-hidden="true">{index + 1}</span>{title}<span className="agent-question-required">{required ? "Required" : "Optional"}</span></label>
          {field.description && <p className="agent-question-description" id={hint}>{field.description}</p>}
          {field.type === "boolean" ? <label className="agent-question-boolean"><input id={base} aria-label={title} type="checkbox" checked={answers[key] === true} disabled={disabled} aria-invalid={!!errorId} aria-describedby={describedBy} onChange={event => set(key, event.target.checked)} /><span>{title}</span></label>
            : field.type === "number" || field.type === "integer" ? <input className="agent-question-input" id={base} aria-label={title} type="number" step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} aria-required={required} aria-invalid={!!errorId} aria-describedby={describedBy} value={String(answers[key] ?? "")} disabled={disabled} onChange={event => set(key, event.target.value === "" ? "" : event.target.valueAsNumber)} />
              : <textarea className="agent-question-input" id={base} aria-label={title} rows={3} aria-required={required} aria-invalid={!!errorId} aria-describedby={describedBy} value={String(answers[key] ?? "")} disabled={disabled} onChange={event => set(key, event.target.value)} />}
          {errors[key] && <p className="agent-question-inline-error" id={errorId}>{errors[key]}</p>}
        </div>
      })}
      {(unsupported.length > 0 || !fields.length) && <p className="agent-request-unsupported" role="status">This request includes a form Still cannot display: {unsupported.join(", ") || "no question fields"}. You can dismiss it or answer in the provider’s own interface.</p>}
    </div>
    <RequestError error={error} busy={busy} reconcile={reconcile} />
    <div className="agent-request-actions"><button className="agent-button" disabled={disabled} type="button" onClick={() => respond(null)}>Dismiss request</button><button className="agent-primary" disabled={disabled || unsupported.length > 0 || !fields.length} type="submit">{busy ? "Sending…" : fields.length > 1 ? "Submit answers" : "Submit answer"}<AgentIcon name="arrow" size={14} /></button></div>
  </form>
}
