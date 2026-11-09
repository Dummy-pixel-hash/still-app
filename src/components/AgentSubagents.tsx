import { useState } from "react"
import type { AgentThreadRow } from "../session/agentThreads"
import { threadTitle } from "../session/agentThreads"
import AgentIcon from "./AgentIcon"
import AgentProviderMark from "./AgentProviderMark"

const statusOf = (row: AgentThreadRow) => row.pendingPermission || row.pendingInput
  ? "Needs you"
  : row.meta.subagentPrepared ? "Prepared · no task sent"
  : row.meta.subagentGuidancePaused && row.meta.subagentGuidance?.length ? "Guidance paused"
    : row.meta.subagentGuidance?.length ? "Guidance queued"
  : row.state === "submissionUnknown" ? "Uncertain"
    : row.state === "error" ? "Turn failed"
      : row.turnActive ? "Working"
        : row.state === "detached" || row.state === "saved" ? "Saved"
          : row.state === "cancelled" ? "Stopped"
            : "Ready"

export default function AgentSubagents({ children, onOpen, onCreate }: {
  children: AgentThreadRow[]
  onOpen: (row: AgentThreadRow) => void
  onCreate: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  if (!children.length) return null
  const active = children.filter(row => row.turnActive || ["connecting", "working", "inputRequired", "detached", "submissionUnknown", "rewinding"].includes(row.state)).length
  const attention = children.filter(row => row.pendingPermission || row.pendingInput || ["error", "submissionUnknown"].includes(row.state)).length

  return <section className="agent-subagents" aria-label="Subagent conversations">
    <div className="agent-subagents-heading">
      <button type="button" className="agent-subagents-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
        <span>Subagents</span>
        <span className="agent-subagents-count">{active ? `${active} active` : `${children.length}`}{attention ? ` · ${attention} needs you` : ""}</span>
        <AgentIcon name="chevron" size={13} style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }} />
      </button>
      <button type="button" className="agent-subagents-create" onClick={onCreate}>New subagent</button>
    </div>
    {!collapsed && <div className="agent-subagents-list">
      {children.map(row => <article className="agent-subagent" key={row.meta.id}>
        <AgentProviderMark id={row.agentId} size={16} />
        <div className="agent-subagent-copy">
          <strong title={threadTitle(row)}>{threadTitle(row)}</strong>
          <span><span className={`agent-subagent-state${row.pendingPermission || row.pendingInput ? " is-attention" : ["error", "submissionUnknown"].includes(row.state) ? " is-error" : row.turnActive ? " is-working" : ""}`} />{row.agentName} · {statusOf(row)}</span>
          {!!row.configOptions.length && <span className="agent-subagent-settings">{row.configOptions.filter(option => ["model", "effort", "thought_level", "reasoning", "mode", "agent_mode"].includes(option.category || "") || ["model", "effort", "mode"].includes(option.id)).map(option => {
            const value = (option.options || []).flatMap(item => "value" in item ? [item] : item.options).find(item => item.value === option.currentValue)
            return `${option.name}: ${value?.name || option.currentValue}`
          }).join(" · ")}</span>}
        </div>
        <button type="button" className="agent-subagent-open" aria-label={`Open ${threadTitle(row)} chat`} onClick={() => onOpen(row)}>Open chat<AgentIcon name="chevron" size={12} /></button>
      </article>)}
    </div>}
  </section>
}
