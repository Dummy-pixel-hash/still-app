import { useId } from "react"
import AgentProviderMark from "../components/AgentProviderMark"
import { sharedUnread, threadTitle, type AgentThreadRow } from "../session/agentThreads"
import { mobileThreadStatus, relativeTime } from "./threads"
import { threadActivity, type MobileProjectGroup } from "./projectThreads"
import MobileIcon from "./MobileIcon"

export function MobileProjectControls({ projects, selected, sort, disabled, onProject, onSort }: {
  projects: MobileProjectGroup[]; selected: string; sort: "recent" | "name"; disabled: boolean
  onProject: (key: string) => void; onSort: (value: "recent" | "name") => void
}) {
  const active = projects.find(project => project.key === selected)
  return <div className="mobile-library-controls">
    <label className="mobile-library-select mobile-library-project-select" data-selected={!!active}>
      <span className="mobile-sr-only">Filter threads by project</span>
      <span className="mobile-library-select-copy" aria-hidden="true"><MobileIcon name="folder" size={18} /><strong>{active?.label || "All projects"}</strong><MobileIcon name="chevron" size={14} /></span>
      {/* Native Android/keyboard picker, with the same value rendered above. */}
      <select aria-label="Filter threads by project" value={active ? selected : "all"} disabled={disabled || !projects.length} onChange={event => onProject(event.target.value)}>
        <option value="all">All projects</option>
        {projects.map(project => <option key={project.key} value={project.key}>{project.label} · {project.serverLabel === project.accountLabel ? project.accountLabel : `${project.serverLabel} (${project.accountLabel})`} · {project.project.folder} · {project.rows.length} {project.rows.length === 1 ? "thread" : "threads"}</option>)}
      </select>
    </label>
    <label className="mobile-library-select mobile-library-sort-select">
      <span className="mobile-sr-only">Sort projects</span>
      <span className="mobile-library-select-copy" aria-hidden="true"><MobileIcon name="sort" size={18} /><strong>{sort === "recent" ? "Recent" : "A–Z"}</strong><MobileIcon name="chevron" size={12} /></span>
      <select aria-label="Sort projects" value={sort} disabled={disabled || projects.length < 2} onChange={event => onSort(event.target.value as "recent" | "name")}>
        <option value="recent">Recent project activity</option><option value="name">Project name (A–Z)</option>
      </select>
    </label>
  </div>
}

export function MobileProjectThreads({ group, collapsed, collapsible, attentionById, onToggle, onOpen }: {
  group: MobileProjectGroup; collapsed: boolean; collapsible: boolean; attentionById: Map<string, boolean>
  onToggle: () => void; onOpen: (row: AgentThreadRow) => void
}) {
  const id = useId(), contentId = `${id}-threads`, contextId = `${id}-context`
  const context = `${group.serverLabel === group.accountLabel ? group.accountLabel : `${group.serverLabel} · ${group.accountLabel}`} · ${group.project.folder}`
  const heading = <><MobileIcon name="folder" size={18} /><span className="mobile-project-group-copy">
    <strong>{group.label}</strong><small id={contextId} title={context}>
      <span className="mobile-project-account">{group.serverLabel !== group.accountLabel && <span className="mobile-project-server-name">{group.serverLabel} · </span>}{group.accountLabel}</span>
      <span className="mobile-project-folder">{group.project.folder}</span>
    </small>
  </span><span className="mobile-project-group-count">{group.rows.length}<span className="mobile-sr-only"> {group.rows.length === 1 ? "thread" : "threads"}</span>{group.attention > 0 && <small>{group.attention} needs you</small>}</span>{collapsible && <span className={`mobile-project-disclosure${collapsed ? " is-collapsed" : ""}`}><MobileIcon name="chevron" size={14} /></span>}</>
  return <section className="mobile-project-group" aria-label={`${group.label} · ${group.accountLabel} · ${group.project.folder}`} data-project-key={group.key}>
    <header><h2>{collapsible ? <button className="mobile-project-group-heading" type="button" aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.label} project · ${group.accountLabel} · ${group.project.folder}`} aria-expanded={!collapsed} aria-controls={contentId} onClick={onToggle}>{heading}</button> : <div className="mobile-project-group-heading">{heading}</div>}</h2></header>
    <div id={contentId} hidden={collapsed}>
      {group.rows.map(row => {
        const pending = attentionById.get(row.executionId) === true, state = mobileThreadStatus(row, pending), unread = sharedUnread(row), activity = threadActivity(row)
        return <button className={`mobile-thread-row ${pending ? "needs-attention" : ""}`} key={row.meta.id} aria-label={`${threadTitle(row)} · ${state}${row.meta.pinned ? " · Pinned" : ""}${unread ? " · Unread activity" : ""}`} aria-describedby={contextId} onClick={() => onOpen(row)}>
          <span className="mobile-thread-provider"><AgentProviderMark id={row.agentId} size={21} /></span>
          <span className="mobile-thread-copy"><strong>{row.meta.pinned && <span className="mobile-thread-pin" aria-hidden="true"><MobileIcon name="pin" size={12} /></span>}{threadTitle(row)}</strong><small>{row.meta.parentConversationId ? "Subagent · " : ""}{row.agentName}</small></span>
          <span className="mobile-thread-trailing">{unread && <span className="mobile-thread-unread" aria-hidden="true">•</span>}{activity > 0 && <time dateTime={new Date(activity).toISOString()}>{relativeTime(activity)}</time>}<span className={pending ? "mobile-thread-state is-attention" : "mobile-thread-state"}>{row.turnActive && !pending ? <span className="mobile-working-bars" aria-hidden="true"><i /><i /><i /></span> : null}{state === "Complete" ? <MobileIcon name="check" size={14} /> : state}</span></span>
        </button>
      })}
    </div>
  </section>
}
