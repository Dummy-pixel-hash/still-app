import { useEffect, useRef, useState } from "react"
import type { AgentConfigOption, AgentConfigOptionValue, AgentCommand } from "../agents/types"
import AgentIcon from "./AgentIcon"

export function configValues(option: AgentConfigOption): AgentConfigOptionValue[] {
  return (option.options || []).flatMap(value => "value" in value ? [value] : value.options)
}
export function ConfigPicker({ option, disabled, change }: { option: AgentConfigOption; disabled: boolean; change: (id: string, value: string | boolean) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null)
  const all = configValues(option)
  const selected = all.find(value => value.value === option.currentValue)
  const filtered = all.filter(value => `${value.name} ${value.value}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [open])
  useEffect(() => { root.current?.querySelector('.agent-picker-options .is-active')?.scrollIntoView({ block: "nearest" }) }, [active])
  const choose = (value: string) => { change(option.id, value); setOpen(false); setQuery("") }
  if (option.type === "boolean") return <label className="agent-toggle"><input type="checkbox" checked={option.currentValue === true} disabled={disabled} onChange={e => change(option.id, e.target.checked)} />{option.name}</label>
  if (option.type !== "select") return <span className="agent-muted">{option.name}: {String(option.currentValue)}</span>
  return <div className="agent-picker" ref={root}>
    <button type="button" className="agent-control" aria-label={`${option.name}: ${selected?.name || option.currentValue || "Default"}`} aria-expanded={open} disabled={disabled} onClick={() => { setOpen(!open); setActive(0) }} title={option.description}>
      <span>{selected?.name || String(option.currentValue || "Default")}</span><AgentIcon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} /></button>
    {open && <div className="agent-picker-popup" onKeyDown={e => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); root.current?.querySelector("button")?.focus() }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(index => Math.min(filtered.length - 1, index + 1)) }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive(index => Math.max(0, index - 1)) }
      if (e.key === "Enter" && filtered[active]) { e.preventDefault(); choose(filtered[active].value) }
    }}>
      <div className="agent-picker-search"><AgentIcon name="search" size={14} /><input ref={input} aria-label={`Search ${option.name.toLowerCase()}`} placeholder={`Search ${option.name.toLowerCase()}…`} value={query} onChange={e => { setQuery(e.target.value); setActive(0) }} /></div>
      <div className="agent-picker-options" role="listbox" aria-label={option.name}>{filtered.map((value, index) => <button type="button" role="option" aria-selected={value.value === option.currentValue} className={active === index ? "is-active" : ""} key={value.value} onClick={() => choose(value.value)} onMouseEnter={() => setActive(index)}>
        <span>{value.name}<small>{value.value !== value.name ? value.value : ""}</small></span>{value.value === option.currentValue && <AgentIcon name="check" size={14} />}</button>)}</div>
      {!filtered.length && <p className="agent-picker-empty">No matching {option.name.toLowerCase()}.</p>}
      <div className="agent-picker-count">{filtered.length} {option.name.toLowerCase()} options</div>
    </div>}
  </div>
}

export function CommandPicker({ commands, query, onQuery, onSelect, onClose }: { commands: AgentCommand[]; query: string; onQuery: (query: string) => void; onSelect: (command: AgentCommand) => void; onClose: () => void }) {
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const list = commands.filter(command => `${command.name} ${command.description}`.toLowerCase().includes(query.replace(/^\//, "").toLowerCase()))
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { root.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" }) }, [active])
  return <div ref={root} className="agent-command-menu" onKeyDown={e => {
    if (e.key === "Escape") { e.stopPropagation(); onClose() }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(index => Math.min(list.length - 1, index + 1)) }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive(index => Math.max(0, index - 1)) }
    if (e.key === "Enter" && list[active]) { e.preventDefault(); onSelect(list[active]) }
  }}>
    <div className="agent-picker-search"><AgentIcon name="command" size={15} /><input ref={input} aria-label="Search commands" placeholder="Search commands…" value={query} onChange={e => { onQuery(e.target.value); setActive(0) }} /><button type="button" className="agent-icon-button" aria-label="Close commands" onClick={onClose}><AgentIcon name="close" size={14} /></button></div>
    <div className="agent-command-options" role="listbox" aria-label="Agent commands">{list.map((command, index) => <button type="button" role="option" aria-selected={index === active} key={command.name} onMouseEnter={() => setActive(index)} onClick={() => onSelect(command)}>
      <strong>/{command.name}</strong><span>{command.description}</span>{command.input?.hint && <small>{command.input.hint}</small>}</button>)}</div>
    {!list.length && <p className="agent-picker-empty">{commands.length ? "No matching commands." : "This agent hasn’t reported any commands for this folder."}</p>}
    <div className="agent-picker-count">{list.length} commands · ↑ ↓ to choose · Enter to insert</div>
  </div>
}
