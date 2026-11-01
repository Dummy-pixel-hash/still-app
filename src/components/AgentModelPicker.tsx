import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { AgentConfigOption, AgentConfigOptionValue } from "../agents/types"
import { useAgentPopover } from "../agents/useAgentPopover"
import AgentIcon from "./AgentIcon"
import AgentProviderMark from "./AgentProviderMark"
import { configValues } from "./AgentControls"

type Props = {
  model?: AgentConfigOption
  disabled: boolean
  disabledReason?: string
  change: (id: string, value: string | boolean) => Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
  provider?: { id: string; name: string }
}

/** A compact model-only list. Selection closes after the agent acknowledges it. */
export default function AgentModelPicker({ model, disabled, disabledReason, change, open, onOpenChange, provider }: Props) {
  const [query, setQuery] = useState(""), [active, setActive] = useState(0)
  const [pending, setPending] = useState<string | null>(null), [error, setError] = useState("")
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const inFlight = useRef(false), mounted = useRef(true), closeAfterUpdate = useRef(false)
  const listId = useId()
  useAgentPopover(popup, open)
  const selected = model && configValues(model).find(value => value.value === model.currentValue)
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
  const label = selected?.name || String(model?.currentValue || "Choose model")
  const activeIndex = Math.max(0, Math.min(active, values.length - 1))

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    if (!open) return
    setQuery(""); setError("")
    setActive(Math.max(0, allModels.findIndex(value => value.value === model?.currentValue)))
    ;(search.current || popup.current?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true })
  }, [open])
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
    if (disabled || inFlight.current) return
    if (value === option.currentValue) { close(); return }
    inFlight.current = true; setPending(`${option.id}:${value}`); setError("")
    try { await change(option.id, value); if (mounted.current) close() }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { inFlight.current = false; if (mounted.current) setPending(null) }
  }
  if (!model) return null
  return <div ref={root} className="agent-picker agent-model-picker" data-config-id="model">
    <button ref={trigger} type="button" className="agent-control agent-model-trigger" aria-label={`Model: ${label}`} aria-description={disabled ? disabledReason : undefined} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${listId}-dialog` : undefined} disabled={disabled && !open && !pending} onClick={() => open ? close() : onOpenChange(true)} title={disabled ? disabledReason : "Choose model"}>
      {provider && <span className="agent-composer-provider" title={provider.name}><AgentProviderMark id={provider.id} size={16} /><span className="agent-sr-only">{provider.name}</span></span>}
      <span className="agent-model-trigger-copy"><strong>{label}</strong></span>
    </button>
    {open && <div ref={popup} id={`${listId}-dialog`} className="agent-model-menu" role="dialog" aria-label="Models" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === "Tab") {
        const controls = [...(popup.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || [])].filter(control => control.tabIndex >= 0 && !control.matches('input[type="radio"]:not(:checked)') && !control.closest("[inert]"))
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
        event.stopPropagation()
      }
      if (event.key === "Enter" && !(event.target as HTMLElement).closest("button")) event.preventDefault()
    }}>
      <div className="agent-model-menu-heading"><strong>Models</strong><button type="button" className="agent-icon-button" aria-label="Close model menu" onClick={close}><AgentIcon name="close" size={15} /></button></div>
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
             <span><strong>{value.name}</strong></span>{pending === `${model?.id}:${value.value}` ? <i className="agent-model-spinner" aria-hidden="true" /> : isSelected && <AgentIcon name="check" size={16} />}
          </button>
        })}</div>)}
        {!filteredGroups.length && <p className="agent-picker-empty">{allModels.length ? "No models match your search." : "This agent has not reported selectable models."}</p>}
      </div>
      {model && !selected && !!model.currentValue && <p className="agent-model-unavailable">Current model: {String(model.currentValue)}. It is not in the latest model list.</p>}
      {error && <p className="agent-model-error" role="alert">{error}</p>}
    </div>}
  </div>
}
