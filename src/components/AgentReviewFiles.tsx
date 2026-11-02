import { useState, type ReactNode } from "react"
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

/** Short windows use a native picker so the file index cannot consume the diff. */
export function ReviewFileSelect({ files, selected, select, source }: { files: Array<{ id: string; path: string }>; selected?: string; select: (id: string) => void; source: "repository" | "conversation" }) {
  return <label className="agent-review-file-select"><span>File</span><select aria-label={`Choose ${source} file`} value={selected} onChange={event => select(event.target.value)}>{files.map(file => <option key={file.id} value={file.id}>{file.path}</option>)}</select></label>
}

/** The same compact, keyboard-operable file index for Git and supplied edits. */
export default function AgentReviewFiles({ files, selected, select, source }: {
  files: ReviewFile[]
  selected?: string
  select: (id: string) => void
  source: "repository" | "conversation"
}) {
  const [query, setQuery] = useState("")
  const filtered = files.filter(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const repository = source === "repository"
  return <div className="agent-review-file-index">
    <div className="agent-review-index-heading"><strong>Files</strong><span>{files.length}</span></div>
    {(files.length > 5 || query) && <label className="agent-review-file-search"><AgentIcon name="search" size={13} /><input aria-label={`Filter ${source} files`} placeholder="Find a file…" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    <div className={repository ? "agent-repository-files" : "agent-review-files"} role="group" aria-label={repository ? "Repository files" : "Changed files"} onKeyDown={event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")]
      const index = buttons.indexOf(event.target as HTMLButtonElement)
      if (index < 0) return
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowUp" ? -1 : 1)))
      event.preventDefault()
      buttons[next]?.focus(); buttons[next]?.click()
    }}>
      {filtered.map(file => <button type="button" key={file.id} aria-label={`${file.path}, ${file.label}`} aria-pressed={file.id === selected}
        className={`${repository ? "agent-repository-file" : "agent-review-file"} ${file.id === selected ? "is-selected" : ""}`}
        title={`${file.path}${file.originalPath ? `\nFrom ${file.originalPath}` : ""}\n${file.label}`} onClick={() => select(file.id)}>
        <AgentIcon name="file" size={14} />
        <span className={repository ? "agent-repository-file-path" : "agent-review-file-path"}><ReviewPath path={file.path} /></span>
        {file.counts}
        <small className={`agent-review-file-status is-${file.status || "unknown"}`} aria-hidden="true">{file.status || "·"}</small>
      </button>)}
      {!filtered.length && <p className="agent-review-no-files">No files match “{query}”.</p>}
    </div>
  </div>
}
