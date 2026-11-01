import { useEffect, useMemo, useState } from "react"
import type { AgentGitDiff, AgentGitEntry, AgentGitSnapshot, AgentGitView } from "../agents/git"
import { describeChanges } from "../agents/changes"
import type { AgentGitStatusState } from "../session/agentGit"
import { agentGitDiffKey } from "../session/agentGit"
import AgentIcon from "./AgentIcon"
import { AgentChangeView } from "./AgentMessage"
import { ChangeNumbers } from "./AgentChanges"

const views: AgentGitView[] = ["combined", "staged", "unstaged"]
const viewLabels: Record<AgentGitView, string> = { combined: "Combined", staged: "Staged", unstaged: "Unstaged" }
const kindLabel: Record<AgentGitEntry["kind"], string> = {
  modified: "Modified", added: "Added", deleted: "Deleted", renamed: "Renamed", copied: "Copied",
  untracked: "Untracked", conflicted: "Conflict", submodule: "Submodule", typeChanged: "Type changed",
}

function checkedLabel(snapshot?: AgentGitSnapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.observedAt)) return "Not checked yet"
  return `Last checked ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(snapshot.observedAt)}`
}

function branchLabel(snapshot: Extract<AgentGitSnapshot, { state: "ready" }>) {
  if (snapshot.detached) return `Detached HEAD · ${snapshot.headOid?.slice(0, 8) || "unknown"}`
  if (snapshot.unborn) return `${snapshot.branch || "Unborn branch"} · no commit yet`
  return snapshot.branch || `HEAD ${snapshot.headOid?.slice(0, 8) || "unknown"}`
}

function stateMessage(state: AgentGitDiff["state"], reason?: string) {
  if (reason) return reason
  switch (state) {
    case "binary": return "Binary content is not rendered as a text diff."
    case "tooLarge": return "This file exceeds the safe preview limit. Refresh status to confirm the current file list."
    case "conflict": return "Resolve this merge conflict before reviewing a text diff."
    case "submodule": return "Submodules are shown as a summary; their contents are not traversed."
    case "symlink": return "Symbolic link content is not followed."
    case "unsupportedPath": return "This path cannot be safely opened as UTF-8 content."
    case "stale": return "The repository changed. Refresh status before opening this diff."
    case "ready": return ""
  }
}

export default function AgentRepositoryChanges({
  host, cwd, active, connected, status, diff, refresh, loadDiff,
}: {
  host: string
  cwd: string
  active: boolean
  connected: boolean
  status: AgentGitStatusState
  diff: { key: string; phase: string; diff?: AgentGitDiff; error?: string }
  refresh: () => Promise<void>
  loadDiff: (entry: AgentGitEntry, view: AgentGitView) => Promise<void>
}) {
  const snapshot = status.snapshot
  const ready = snapshot?.state === "ready" ? snapshot : undefined
  const entries = ready?.entries || []
  const [selectedId, setSelectedId] = useState("")
  const [view, setView] = useState<AgentGitView>("combined")
  const selected = entries.find(entry => entry.id === selectedId) || entries[0]
  const activeDiffKey = selected && ready ? agentGitDiffKey(ready.snapshotId, selected.id, view) : ""
  const activeDiff = diff.key === activeDiffKey ? diff : undefined
  const source = useMemo(() => selected && activeDiff?.diff?.state === "ready" && activeDiff.diff.patch
    ? { type: "patch" as const, path: selected.path, patch: activeDiff.diff.patch }
    : null, [selected?.id, selected?.path, activeDiff?.diff?.snapshotId, activeDiff?.diff?.patch, activeDiff?.diff?.state])
  const parsed = useMemo(() => source ? describeChanges(source) : [], [source])

  useEffect(() => {
    setSelectedId("")
    setView("combined")
  }, [ready?.snapshotId])
  useEffect(() => {
    if (active && selected && ready && connected && status.phase !== "loading") void loadDiff(selected, view)
  }, [active, selected?.id, ready?.snapshotId, view, connected, status.phase, loadDiff])

  const onScopeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = views.indexOf(view)
    const nextIndex = event.key === "ArrowRight" ? (currentIndex + 1) % views.length
      : event.key === "ArrowLeft" ? (currentIndex + views.length - 1) % views.length
        : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : -1
    if (nextIndex < 0) return
    event.preventDefault()
    setView(views[nextIndex])
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[nextIndex]?.focus()
  }

  const canRefresh = connected && status.phase !== "loading"
  const lastChecked = checkedLabel(snapshot)

  return <section className="agent-repository" aria-label="Repository changes" aria-busy={status.phase === "loading"}>
    <header className="agent-repository-header">
      <div className="agent-repository-identity">
        <span className="agent-repository-server">{host}</span>
        {ready && <>
          <div className="agent-repository-location">
            <span className="agent-repository-branch"><AgentIcon name="code" size={13} />{branchLabel(ready)}</span>
            <code title={ready.root}>{ready.root}</code>
          </div>
        </>}
        {!ready && cwd && <code title={cwd}>{cwd}</code>}
      </div>
      <div className="agent-repository-refresh">
        <span>{lastChecked}</span>
        <button type="button" className="agent-button" onClick={() => { void refresh() }} disabled={!canRefresh}>
          <AgentIcon name="refresh" size={13} /> Refresh
        </button>
      </div>
    </header>

    {!connected && <p className="agent-repository-notice" role="status">{snapshot ? "Offline · showing the last read snapshot." : "Connect to this server to inspect its repository."}</p>}
    {connected && status.phase === "stale" && snapshot && !status.error && <p className="agent-repository-notice" role="status">Showing the last checked snapshot until this connection is refreshed.</p>}
    {status.phase === "loading" && <p className="agent-repository-notice" role="status">{snapshot ? "Refreshing repository status…" : "Reading repository status…"}</p>}
    {status.error && snapshot && <p className="agent-repository-error" role="alert">{status.error}</p>}

    {snapshot?.state === "notRepository" && <div className="agent-repository-empty"><AgentIcon name="file" size={22} /><h3>This folder is not inside a Git working tree.</h3><p>Conversation changes are still available in the Conversation view.</p></div>}
    {snapshot?.state === "gitUnavailable" && <div className="agent-repository-empty"><AgentIcon name="terminal" size={22} /><h3>Git is unavailable on this server.</h3><p>{snapshot.reason}</p></div>}
    {!snapshot && status.phase === "idle" && connected && <div className="agent-repository-empty"><AgentIcon name="changes" size={22} /><h3>Repository status has not been read.</h3><p>Open Repository while connected to inspect the selected conversation’s folder.</p></div>}
    {!snapshot && status.phase === "error" && <div className="agent-repository-state is-error" role="alert">
      <AgentIcon name="changes" size={18} />
      <div><strong>Couldn’t read repository status</strong><p>{status.error || "Reconnect or retry to inspect this working tree."}</p></div>
      <button type="button" className="agent-button" onClick={() => { void refresh() }} disabled={!canRefresh}>Try again</button>
    </div>}

    {ready && <>
      {ready.truncated && <p className="agent-repository-notice" role="status">The file list reached its safety limit. Refresh to check again; this partial list is not a clean result.</p>}
      {ready.entries.length === 0 && !ready.truncated && <div className="agent-repository-empty"><AgentIcon name="check" size={22} /><h3>No uncommitted changes.</h3><p>Refresh to check the current server-side working tree.</p></div>}
      {ready.entries.length > 0 && <>
        <div className="agent-repository-files-heading"><strong>Changed files</strong><span>{ready.entries.length}{ready.truncated ? "+" : ""}</span></div>
        <div className="agent-repository-files" role="group" aria-label="Repository files">
          {entries.map(entry => <button type="button" key={entry.id} aria-pressed={entry.id === selected?.id}
            aria-label={`${entry.path}, ${kindLabel[entry.kind]}, index ${entry.indexStatus}, worktree ${entry.worktreeStatus}`}
            className={`agent-repository-file ${entry.id === selected?.id ? "is-selected" : ""}`}
            onClick={() => setSelectedId(entry.id)} title={entry.path}>
            <span className="agent-repository-xy" aria-label={`Index ${entry.indexStatus}; worktree ${entry.worktreeStatus}`}>{entry.indexStatus}{entry.worktreeStatus}</span>
            <span className="agent-repository-file-path">{entry.path}</span>
            <span className="agent-repository-file-meta">
              <span className="agent-repository-kind">{kindLabel[entry.kind]}</span>
              {entry.originalPath && <span className="agent-repository-origin" title={`Renamed from ${entry.originalPath}`}>from {entry.originalPath}</span>}
              {entry.binary ? <small className="agent-repository-binary">Binary</small> : entry.additions !== null && entry.deletions !== null
                ? <ChangeNumbers additions={entry.additions} deletions={entry.deletions} /> : null}
            </span>
          </button>)}
        </div>
        {selected && <>
          <div className="agent-repository-scope" role="tablist" aria-label="Diff scope" onKeyDown={onScopeKeyDown}>
            {views.map(scope => <button type="button" role="tab" key={scope} aria-selected={view === scope} tabIndex={view === scope ? 0 : -1}
              onClick={() => setView(scope)}>{viewLabels[scope]}</button>)}
          </div>
          <div className="agent-review-diff agent-repository-diff" role="region" aria-label={`${viewLabels[view]} diff for ${selected.path}`} tabIndex={0}>
            {activeDiff?.phase === "loading" && <p className="agent-repository-diff-message" role="status">Loading {viewLabels[view].toLowerCase()} diff…</p>}
            {activeDiff?.error && <p className="agent-repository-error" role="alert">{activeDiff.error}</p>}
            {activeDiff?.diff && activeDiff.diff.state !== "ready" && <div className={`agent-repository-diff-message is-${activeDiff.diff.state}`} role={activeDiff.diff.state === "stale" ? "status" : "note"}>
              <strong>{stateMessage(activeDiff.diff.state, activeDiff.diff.reason)}</strong>
              {activeDiff.diff.state === "stale" && <button type="button" className="agent-link-button" onClick={() => { void refresh() }}>Refresh repository</button>}
            </div>}
            {parsed.map((change, index) => <AgentChangeView key={`${selected.id}:${view}:${index}`} change={{ ...change, path: selected.path }} sourceLabel="Repository diff" />)}
            {activeDiff?.diff?.state === "ready" && (!activeDiff.diff.patch || parsed.length === 0) && <p className="agent-repository-diff-message">No changes in this diff scope.</p>}
            {!activeDiff && connected && selected && <p className="agent-repository-diff-message" role="status">Loading selected diff…</p>}
            {!activeDiff && !connected && selected && <p className="agent-repository-diff-message" role="status">Reconnect to load this file’s diff.</p>}
          </div>
        </>}
      </>}
    </>}
  </section>
}
