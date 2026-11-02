import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import type { AgentTodoSnapshot, AgentTodoSync } from "../agents/types"
import AgentIcon from "./AgentIcon"

const statusText = (status: string) => status === "completed" ? "Done" : "Not done"
const durationText = (milliseconds: number) => {
  const seconds=Math.max(0,Math.floor(milliseconds/1000))
  return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m${seconds%60?` ${seconds%60}s`:""}`
}

export default function AgentTodos({ todos, sync, expanded, expand, collapse, id = "agent-todos-full" }: {
  todos?: AgentTodoSnapshot
  sync?: AgentTodoSync
  expanded: boolean
  expand: () => void
  collapse: () => void
  id?: string
}) {
  const collapsedButton = useRef<HTMLButtonElement>(null)
  const expandedButton = useRef<HTMLButtonElement>(null)
  const [now,setNow]=useState(Date.now)
  const items = todos?.items || []
  const activeId=todos?.activeId || items.find(item=>item.status==="pending")?.id
  const activeItem=items.find(item=>item.id===activeId&&item.status==="pending")
  const done=items.filter(item=>item.status==="completed").length
  const observation = sync?.state === "conflict" ? sync.reason || "Showing saved Todos; the remote list does not match."
    : sync?.state === "stale" ? sync.reason || "Showing saved Todos; updates may have continued on the server."
      : sync?.state === "unavailable" ? sync.reason || "This execution cannot provide Todo updates. Saved tasks remain readable."
        : todos?.available === false ? "This execution cannot provide Todo updates. Saved tasks remain readable." : undefined
  const durationFor=(item:typeof items[number])=>item.durationMs!==undefined?durationText(item.durationMs):item.startedAt!==undefined&&item.completedAt!==undefined?durationText(item.completedAt-item.startedAt):item.id===activeItem?.id&&item.startedAt!==undefined?durationText(now-item.startedAt):"…"
  const expandAndFocus = () => {
    expand()
    requestAnimationFrame(() => expandedButton.current?.focus({ preventScroll: true }))
  }
  const collapseAndFocus = () => {
    collapse()
    requestAnimationFrame(() => collapsedButton.current?.focus({ preventScroll: true }))
  }
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (expanded && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); collapseAndFocus() }
  }
  useEffect(()=>{
    if(!expanded||activeItem?.startedAt===undefined)return
    const interval=window.setInterval(()=>setNow(Date.now()),1000)
    return ()=>window.clearInterval(interval)
  },[expanded,activeItem?.id,activeItem?.startedAt])

  return <section className={`agent-todos${expanded ? " is-expanded" : ""}`} aria-label="Conversation Todos" onKeyDown={keyDown}>
    <div className={`agent-todos-states${expanded ? " is-expanded" : ""}`}>
      <div className="agent-todos-state-clip" aria-hidden={expanded} inert={expanded}>
        <button ref={collapsedButton} type="button" className="agent-todo-progress-pill" aria-label={`${done} of ${items.length} Todos done. Expand list`} aria-expanded={expanded} aria-controls={id} onClick={expandAndFocus}>
          <span className="agent-todo-progress-dot" aria-hidden="true" />
          <span>{done}/{items.length} Todos done</span>
          <AgentIcon name="chevron" size={14} style={{ transform: "rotate(-90deg)" }} />
        </button>
      </div>
      <div className="agent-todos-state-clip" id={id} aria-hidden={!expanded} inert={!expanded}>
        <div className="agent-todo-card">
          <header className="agent-todos-heading">
            <div className="agent-todos-heading-copy"><h2>Agent Todo</h2><span className="agent-todos-progress"><i aria-hidden="true" />{done} / {items.length}</span></div>
            <button ref={expandedButton} className="agent-icon-button agent-todos-expand" type="button" aria-label="Collapse Todos" title="Collapse Todos" aria-expanded={expanded} aria-controls={id} onClick={collapseAndFocus}>
              <AgentIcon name="chevron" size={15} style={{ transform: "rotate(90deg)" }} />
            </button>
          </header>
          {items.length === 0 ? <p className="agent-todo-empty">The agent has not added any Todos to this conversation yet.</p> : <ol className="agent-todo-full-list" tabIndex={expanded ? 0 : -1} aria-label="Agent tasks">
            {items.map(item => {
              const current=item.id===activeItem?.id
              return <li className={`agent-todo-readonly is-${item.status}${current?" is-current":""}`} key={item.id}>
                <span className={`agent-todo-status-mark is-${item.status}${current?" is-current":""}`} aria-label={statusText(item.status)}>{item.status === "completed" ? "✓" : ""}</span>
                <div className="agent-todo-readonly-body">
                   <div className="agent-todo-readonly-line"><span className="agent-todo-readonly-title">{item.title}</span><span className="agent-todo-readonly-meta">{statusText(item.status)} <time title={item.status === "pending" && item.startedAt !== undefined ? "Elapsed since task start, not verified continuous work" : "Recorded task duration"}>{durationFor(item)}</time></span></div>
                  {current&&item.detail&&<p className="agent-todo-detail">{item.detail}</p>}
                </div>
              </li>
            })}
          </ol>}
           {observation && <p className="agent-todos-offline" role="status">{observation}</p>}
        </div>
      </div>
    </div>
  </section>
}
