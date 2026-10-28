import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import type { AgentConfigOption, AgentConfigOptionValue, AgentCommand } from "../agents/types"
import AgentIcon from "./AgentIcon"
import { useAgentPopover } from "../agents/useAgentPopover"

export function configValues(option: AgentConfigOption): AgentConfigOptionValue[] {
  return (option.options || []).flatMap(value => "value" in value ? [value] : value.options)
}
export function ConfigPicker({ option, disabled, change, icon }: { option: AgentConfigOption; disabled: boolean; change: (id: string, value: string | boolean) => void; icon?: ReactNode }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef(false)
  useAgentPopover(popup, open)
  const listId = useId()
  const all = configValues(option)
  const selected = all.find(value => value.value === option.currentValue)
  const filtered = all.filter(value => `${value.name} ${value.value} ${value.description || ""}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [open])
  useEffect(() => { revealOption(root.current, '.agent-picker-options .is-active') }, [active, query, open])
  useEffect(() => {
    if (disabled || open || !restoreFocus.current) return
    restoreFocus.current = false
    if (document.activeElement === document.body) root.current?.querySelector("button")?.focus({ preventScroll: true })
  }, [disabled, open])
  const choose = (value: string) => { restoreFocus.current = true; change(option.id, value); setOpen(false); setQuery(""); root.current?.querySelector("button")?.focus() }
  if (option.type === "boolean") return <label className="agent-toggle"><input type="checkbox" checked={option.currentValue === true} disabled={disabled} onChange={e => change(option.id, e.target.checked)} />{option.name}</label>
  if (option.type !== "select") return <span className="agent-muted">{option.name}: {String(option.currentValue)}</span>
  return <div className="agent-picker" ref={root} data-config-id={option.id}>
    <button type="button" className="agent-control" aria-label={`${option.name}: ${selected?.name || option.currentValue || "Default"}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => { setOpen(!open); setQuery(""); setActive(Math.max(0, all.findIndex(value => value.value === option.currentValue))) }} title={option.description || option.name}>
      {icon}<span>{selected?.name || String(option.currentValue || "Default")}</span><AgentIcon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} /></button>
    {open && <div ref={popup} className="agent-picker-popup" onKeyDown={e => {
      e.stopPropagation()
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); root.current?.querySelector("button")?.focus() }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault()
        const next = Math.max(0, Math.min(filtered.length - 1, e.key === "Home" ? 0 : e.key === "End" ? filtered.length - 1 : active + (e.key === "ArrowDown" ? 1 : -1)))
        setActive(next)
        if (e.target !== input.current) popup.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus()
      }
      if (e.key === "Enter" && e.target === input.current && !e.nativeEvent.isComposing) { e.preventDefault(); if (filtered[active]) choose(filtered[active].value) }
    }}>
      <div className="agent-picker-search"><AgentIcon name="search" size={14} /><input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined} aria-label={`Search ${option.name.toLowerCase()}`} placeholder={`Search ${option.name.toLowerCase()}…`} value={query} onChange={e => { setQuery(e.target.value); setActive(0) }} /></div>
      <div id={listId} className="agent-picker-options" role="listbox" aria-label={option.name}>{filtered.map((value, index) => <button id={`${listId}-${index}`} type="button" role="option" aria-selected={value.value === option.currentValue} className={active === index ? "is-active" : ""} key={value.value} onClick={() => choose(value.value)} onFocus={() => setActive(index)} onMouseEnter={() => setActive(index)}>
        <span>{value.name}<small>{value.description || (value.value !== value.name ? value.value : "")}</small></span>{value.value === option.currentValue && <AgentIcon name="check" size={14} />}</button>)}</div>
      {!filtered.length && <p className="agent-picker-empty">No matching {option.name.toLowerCase()}.</p>}
      <div className="agent-picker-count">{filtered.length} {option.name.toLowerCase()} options</div>
    </div>}
  </div>
}

function revealOption(root: HTMLElement | null, selector: string) {
  const option = root?.querySelector<HTMLElement>(selector), list = option?.parentElement
  if (!option || !list) return
  const top = option.getBoundingClientRect().top - list.getBoundingClientRect().top
  if (top < 0) list.scrollTop += top
  else if (top + option.offsetHeight > list.clientHeight) list.scrollTop += top + option.offsetHeight - list.clientHeight
}

export function CommandPicker({ commands, query, onQuery, onSelect, onClose, loading, error, refresh }: { commands: AgentCommand[]; query: string; onQuery: (query: string) => void; onSelect: (command: AgentCommand) => void; onClose: () => void; loading?: boolean; error?: string; refresh?: () => void }) {
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  useAgentPopover(root, true)
  const listId = useId()
  const list = commands.filter(command => `${command.name} ${command.aliases?.join(" ") || ""} ${command.description} ${command.source || ""}`.toLowerCase().includes(query.replace(/^\//, "").toLowerCase()))
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { revealOption(root.current, '[role="option"][aria-selected="true"]') }, [active, query])
  useEffect(() => { const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onClose() }; document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside) }, [onClose])
  return <div ref={root} className="agent-command-menu" onKeyDown={e => {
    e.stopPropagation()
    if (e.key === "Escape") { e.stopPropagation(); onClose() }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && (e.target === input.current || (e.target as HTMLElement).getAttribute("role") === "option")) {
      e.preventDefault()
      const next = Math.max(0, Math.min(list.length - 1, e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : active + (e.key === "ArrowDown" ? 1 : -1)))
      setActive(next)
      if (e.target !== input.current) root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus()
    }
    if (e.key === "Enter" && e.target === input.current && !e.nativeEvent.isComposing) { e.preventDefault(); if (list[active]) onSelect(list[active]) }
  }}>
    <div className="agent-picker-search"><AgentIcon name="command" size={15} /><input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={list[active] ? `${listId}-${active}` : undefined} aria-label="Search commands" placeholder="Search commands and skills…" value={query} onChange={e => { onQuery(e.target.value); setActive(0) }} />{refresh && <button type="button" className="agent-icon-button" aria-label="Refresh commands" disabled={loading} onClick={refresh}><AgentIcon name="refresh" size={14} /></button>}<button type="button" className="agent-icon-button" aria-label="Close commands" onClick={onClose}><AgentIcon name="close" size={14} /></button></div>
    {error && <p className="agent-command-error" role="status">{error}</p>}
    <div id={listId} className="agent-command-options" role="listbox" aria-label="Agent commands">{list.map((command, index) => <button id={`${listId}-${index}`} type="button" role="option" aria-selected={index === active} aria-disabled={!!command.unavailable} title={command.unavailable} key={`${command.route || "command"}:${command.name}`} onFocus={() => setActive(index)} onMouseEnter={() => setActive(index)} onClick={() => onSelect(command)}>
      <span className="agent-command-name"><strong>{command.route === "skill" ? `@${command.name.replace(/^skill:/, "")}` : `/${command.name}`}</strong><small>{command.source || "Agent command"}{command.unavailable ? " · TUI only" : ""}</small></span><span className="agent-command-description">{command.description}{command.input?.hint && <small>{command.input.hint}</small>}{command.aliases?.length && <small>{command.aliases.map(alias => `/${alias}`).join(" · ")}</small>}</span></button>)}</div>
    {!list.length && <p className="agent-picker-empty">{commands.length ? "No matching commands." : "This agent hasn’t reported any commands for this folder."}</p>}
    <div className="agent-picker-count"><span>{loading ? "Refreshing project inventory…" : `${list.length} commands & actions`}</span><span>↑ ↓ navigate · ↵ select</span></div>
  </div>
}
