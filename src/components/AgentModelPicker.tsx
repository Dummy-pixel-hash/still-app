import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { AgentConfigOption, AgentConfigOptionValue } from "../agents/types"
import { useAgentPopover } from "../agents/useAgentPopover"
import AgentIcon from "./AgentIcon"
import { configValues } from "./AgentControls"

type Props = {
  model?: AgentConfigOption
  reasoning?: AgentConfigOption
  disabled: boolean
  disabledReason?: string
  change: (id: string, value: string | boolean) => Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
  focusReasoning?: boolean
}

/** One configuration surface: model selection stays open for its advertised reasoning choices. */
export default function AgentModelPicker({ model, reasoning, disabled, disabledReason, change, open, onOpenChange, focusReasoning }: Props) {
  const [query, setQuery] = useState(""), [active, setActive] = useState(0)
  const [pending, setPending] = useState<string | null>(null), [error, setError] = useState("")
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const inFlight = useRef(false), mounted = useRef(true), closeAfterUpdate = useRef(false)
  const listId = useId()
  useAgentPopover(popup, open)
  const selected = model && configValues(model).find(value => value.value === model.currentValue)
  const selectedReasoning = reasoning && configValues(reasoning).find(value => value.value === reasoning.currentValue)
  const groups = useMemo(() => {
    const result: Array<{ name: string; values: AgentConfigOptionValue[] }> = []
    for (const entry of model?.options || []) {
      if ("value" in entry) {
        if (result.at(-1)?.name !== "") result.push({ name: "", values: [] })
        result.at(-1)!.values.push(entry)
      } else result.push({ name: entry.name, values: entry.options })
    }
    return result
  }, [model?.options])
  const filteredGroups = groups.map(group => ({ ...group, values: group.values.filter(value => `${group.name} ${value.name} ${value.value} ${value.description || ""}`.toLowerCase().includes(query.trim().toLowerCase())) })).filter(group => group.values.length)
  const values = filteredGroups.flatMap(group => group.values)
  const allModels = model ? configValues(model) : []
  const reasoningValues = reasoning ? configValues(reasoning) : []
  const label = selected?.name || String(model?.currentValue || "Choose model")
  const reasoningLabel = selectedReasoning?.name || String(reasoning?.currentValue ?? "")
  const activeIndex = Math.max(0, Math.min(active, values.length - 1))

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    if (!open) return
    setQuery(""); setError("")
    setActive(Math.max(0, allModels.findIndex(value => value.value === model?.currentValue)))
    const target = focusReasoning ? popup.current?.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled),input[type="radio"]:not(:disabled)') : search.current
    ;(target || search.current || popup.current?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true })
  }, [open, focusReasoning])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false)
    }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [open, onOpenChange])
  useLayoutEffect(() => {
    const option = popup.current?.querySelector<HTMLElement>(`[id="${CSS.escape(`${listId}-${activeIndex}`)}"]`)
    if (!open || !option || !list.current) return
    const top = option.getBoundingClientRect().top - list.current.getBoundingClientRect().top
    if (top < 0) list.current.scrollTop += top
    else if (top + option.offsetHeight > list.current.clientHeight) list.current.scrollTop += top + option.offsetHeight - list.current.clientHeight
  }, [activeIndex, query, open, model?.options])
  useEffect(() => {
    if (open || disabled || !closeAfterUpdate.current) return
    closeAfterUpdate.current = false
    if (document.activeElement === document.body) trigger.current?.focus({ preventScroll: true })
  }, [open, disabled])
  const close = () => {
    closeAfterUpdate.current = true
    onOpenChange(false)
    trigger.current?.focus({ preventScroll: true })
  }
  const apply = async (option: AgentConfigOption, value: string) => {
    if (disabled || inFlight.current || value === option.currentValue) return
    inFlight.current = true; setPending(`${option.id}:${value}`); setError("")
    try { await change(option.id, value) }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { inFlight.current = false; if (mounted.current) setPending(null) }
  }
  if (!model && !reasoning) return null
  return <div ref={root} className="agent-picker agent-model-picker" data-config-id="model-reasoning">
    <button ref={trigger} type="button" className="agent-control agent-model-trigger" aria-label={`Model: ${label}`} aria-description={reasoning ? `Reasoning: ${reasoningLabel || "Default"}` : disabledReason} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${listId}-dialog` : undefined} disabled={disabled && !open && !pending} onClick={() => open ? close() : onOpenChange(true)} title={disabled ? disabledReason : `Choose model${reasoning ? ` and reasoning · ${reasoningLabel}` : ""}`}>
      <span className="agent-model-trigger-copy"><strong>{label}</strong>{reasoning && <small>{reasoningLabel || "Default"}</small>}</span><AgentIcon name="chevron" size={13} style={{ transform: "rotate(90deg)" }} />
    </button>
    {open && <div ref={popup} id={`${listId}-dialog`} className="agent-model-menu" role="dialog" aria-label="Model and reasoning" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === "Tab") {
        const controls = [...(popup.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || [])].filter(control => control.tabIndex >= 0 && !control.matches('input[type="radio"]:not(:checked)') && !control.closest("[inert]"))
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
        event.stopPropagation()
      }
      if (event.key === "Enter" && !(event.target as HTMLElement).closest("button")) event.preventDefault()
    }}>
      <div className="agent-model-menu-heading"><div><strong>Choose a model</strong><span>{allModels.length ? `${allModels.length} available` : "No model choices reported"}</span></div><button type="button" className="agent-icon-button" aria-label="Close model menu" onClick={close}><AgentIcon name="close" size={15} /></button></div>
      {!!allModels.length && <div className="agent-picker-search"><AgentIcon name="search" size={15} /><input ref={search} type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label="Search models" aria-controls={listId} aria-activedescendant={values[activeIndex] ? `${listId}-${activeIndex}` : undefined} placeholder="Search models…" value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setActive(Math.max(0, Math.min(values.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)))) }
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); if (model && values[activeIndex]) void apply(model, values[activeIndex].value) }
      }} />{query && <button type="button" className="agent-icon-button" aria-label="Clear model search" onClick={() => { setQuery(""); setActive(0); search.current?.focus() }}><AgentIcon name="close" size={14} /></button>}</div>}
      <div ref={list} id={listId} className="agent-model-options" role="listbox" aria-label="Models" aria-busy={pending !== null} onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const next = Math.max(0, Math.min(values.length - 1, event.key === "Home" ? 0 : event.key === "End" ? values.length - 1 : activeIndex + (event.key === "ArrowDown" ? 1 : -1)))
        setActive(next)
        list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus({ preventScroll: true })
      }}>
        {filteredGroups.map((group, groupIndex) => <div role="group" aria-label={group.name || undefined} className="agent-model-group" key={`${group.name}-${groupIndex}`}>{group.name && <div className="agent-model-group-label" aria-hidden="true">{group.name}</div>}{group.values.map(value => {
          const index = values.indexOf(value), isSelected = value.value === model?.currentValue
           return <button id={`${listId}-${index}`} type="button" role="option" aria-label={value.name} title={value.value !== value.name ? `${value.name} · ${value.value}` : value.name} aria-selected={isSelected} aria-disabled={disabled || pending !== null} tabIndex={index === activeIndex ? 0 : -1} className={index === activeIndex ? "is-active" : ""} key={value.value} onFocus={() => setActive(index)} onMouseEnter={() => { if (document.activeElement === search.current) setActive(index) }} onClick={() => { if (model) void apply(model, value.value) }}>
            <span><strong>{value.name}</strong>{value.description && <small>{value.description}</small>}{value.value !== value.name && <code>{value.value}</code>}</span>{pending === `${model?.id}:${value.value}` ? <i className="agent-model-spinner" aria-hidden="true" /> : isSelected && <AgentIcon name="check" size={16} />}
          </button>
        })}</div>)}
        {!filteredGroups.length && <p className="agent-picker-empty">{allModels.length ? "No models match your search." : "This agent has not reported selectable models."}</p>}
      </div>
      {model && !selected && !!model.currentValue && <p className="agent-model-unavailable">Current model: {String(model.currentValue)}. It is not in the latest model list.</p>}
      {reasoning && <fieldset className="agent-reasoning-options"><legend>{reasoning.name || "Reasoning"}</legend><div role="radiogroup" aria-label="Reasoning">{reasoningValues.map(value => <label className={value.value === reasoning.currentValue ? "is-selected" : ""} key={value.value}><input type="radio" name={`${listId}-reasoning`} value={value.value} checked={value.value === reasoning.currentValue} aria-disabled={disabled || pending !== null} onChange={() => { void apply(reasoning, value.value) }} /><span>{value.name}</span></label>)}</div>{!reasoningValues.length && <small>Reasoning choices appear when this model is ready.</small>}</fieldset>}
      {error && <p className="agent-model-error" role="alert">{error}</p>}
      <div className="agent-model-menu-footer"><span role="status">{pending ? "Updating configuration…" : disabled ? disabledReason || "Configuration is read-only" : "Changes apply immediately"}</span><button className="agent-button" type="button" onClick={close}>Done</button></div>
    </div>}
  </div>
}
