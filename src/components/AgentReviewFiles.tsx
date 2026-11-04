import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import AgentIcon from "./AgentIcon"

export interface ReviewFile {
  id: string
  path: string
  label: string
  status?: string
  counts?: ReactNode
  originalPath?: string
}

export function ReviewPath({ path }: { path: string }) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return <><span className="agent-review-path-directory">{path.slice(0, slash + 1)}</span><span className="agent-review-path-name">{path.slice(slash + 1)}</span></>
}

/** File navigation replaces project navigation in review, without changing its preference. */
export default function AgentReviewFiles({ files, selected, select, source }: {
  files: ReviewFile[]
  selected?: string
  select: (id: string) => void
  source: "repository" | "conversation"
}) {
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const [compact, setCompact] = useState(() => matchMedia("(max-width: 900px)").matches)
  const [expanded, setExpanded] = useState(true)
  const [compactOpen, setCompactOpen] = useState(false)
  const [query, setQuery] = useState("")
  const open = compact ? compactOpen : expanded
  const current = files.find(file => file.id === selected) || files[0]
  const filtered = files.filter(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const repository = source === "repository"

  useEffect(() => {
    const media = matchMedia("(max-width: 900px)")
    let focusFrame = 0
    const sync = () => {
      const indexHasFocus = root.current?.querySelector(".agent-review-file-index")?.contains(document.activeElement)
      const indexWillClose = media.matches || !expanded
      setCompact(media.matches)
      setCompactOpen(false)
      if (indexHasFocus && indexWillClose) focusFrame = requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
    }
    media.addEventListener("change", sync)
    return () => { media.removeEventListener("change", sync); cancelAnimationFrame(focusFrame) }
  }, [expanded])

  const choose = (id: string) => {
    select(id)
    if (compact) {
      setCompactOpen(false)
      requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
    }
  }

  return <div ref={root} className={`agent-review-file-picker${open ? " is-open" : ""}${compact ? " is-compact" : ""}`} onKeyDown={event => {
    if (event.key === "Escape" && open && compact) {
      event.preventDefault()
      event.stopPropagation()
      setCompactOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    if (event.target instanceof HTMLElement && event.target.closest(".agent-review-file-search")) return
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>(".agent-review-file-index button") || [])]
    if (!buttons.length) return
    event.preventDefault()
    event.stopPropagation()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }}>
    <button ref={trigger} type="button" className="agent-review-file-trigger" title={open ? "Hide files" : "Show files"} aria-label={`Choose ${source} file${current ? `, current ${current.path}` : ""}`} aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => compact ? setCompactOpen(value => !value) : setExpanded(value => !value)}>
      <AgentIcon name="panel" size={16} /><span>Files</span><small>{files.length}</small>
    </button>
    {open && <div id={listId} className="agent-review-file-index" role="group" aria-label={`${repository ? "Repository" : "Conversation"} files`}>
      <label className="agent-review-file-search"><AgentIcon name="search" size={13} /><input aria-label={`Filter ${source} files`} placeholder="Find a file…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className={repository ? "agent-repository-files" : "agent-review-files"}>
        {filtered.map(file => <button type="button" key={file.id} aria-label={`${file.path}, ${file.label}`} aria-pressed={file.id === current?.id}
          className={`${repository ? "agent-repository-file" : "agent-review-file"} ${file.id === current?.id ? "is-selected" : ""}`}
          title={`${file.path}${file.originalPath ? `\nFrom ${file.originalPath}` : ""}\n${file.label}`} onClick={() => choose(file.id)}>
          <AgentIcon name="file" size={14} />
          <span className={repository ? "agent-repository-file-path" : "agent-review-file-path"}><strong>{file.path.split(/[\\/]/).at(-1)}</strong><small>{file.path.slice(0, Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")) + 1).replace(/[\\/]$/, "") || "Project root"}</small></span>
          {file.counts}
          <small className={`agent-review-file-status is-${file.status || "unknown"}`} aria-hidden="true">{file.status || "·"}</small>
        </button>)}
        {!filtered.length && <p className="agent-review-no-files">No files match “{query}”.</p>}
      </div>
    </div>}
  </div>
}
