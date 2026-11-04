import { memo, useMemo } from "react"
import type { StructuredPatchHunk } from "diff"
import type { ReportedChange } from "../agents/changes"
import { highlightCode, languageForPath } from "../agents/syntax"

/** Review owns its rendering; transcript/tool previews keep their existing appearance. */
const ReviewPatch = memo(function ReviewPatch({ path, hunks }: { path: string; hunks: StructuredPatchHunk[] }) {
  const rows = useMemo(() => {
    const color = hunks.reduce((size, hunk) => size + hunk.lines.join("\n").length, 0) <= 80000
    return hunks.flatMap(hunk => {
      let oldLine = hunk.oldStart, newLine = hunk.newStart
      return [{ kind: "hunk", text: `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, before: "", after: "", sign: "", html: null as string | null }, ...hunk.lines.map(line => {
        if (line.startsWith("\\")) return { kind: "meta", text: line, before: "", after: "", sign: "", html: null }
        const add = line.startsWith("+"), remove = line.startsWith("-"), text = line.slice(1)
        return { kind: add ? "add" : remove ? "remove" : "context", text, before: add ? "" : String(oldLine++), after: remove ? "" : String(newLine++), sign: add ? "+" : remove ? "−" : " ", html: color ? highlightCode(text, languageForPath(path)) : null }
      })]
    })
  }, [path, hunks])
  return <pre className="agent-patch agent-review-patch" tabIndex={0} aria-label={`Code changes in ${path}`}>{rows.map((row, index) => <span key={index} className={`agent-diff-line diff-${row.kind}`}>
    <span className="agent-review-gutter" aria-hidden="true"><span className="agent-line-number">{row.before}</span><span className="agent-line-number">{row.after}</span><span className="agent-diff-sign">{row.sign}</span></span>
    {row.html === null ? <code>{row.text}{"\n"}</code> : <code dangerouslySetInnerHTML={{ __html: row.html + "\n" }} />}
  </span>)}</pre>
})

export default function AgentReviewDiff({ change, sourceLabel = "Original provider patch" }: { change: ReportedChange; sourceLabel?: string }) {
  if (change.preview === "written" && change.source.type === "diff") return <div className="agent-diff"><p className="agent-diff-fallback">Written content · the agent did not supply the original file. Line totals are unavailable.</p><pre className="agent-written-content" tabIndex={0} aria-label={`Written content for ${change.path}`}>{change.source.newText}</pre></div>
  return <div className="agent-diff">
    {change.preview === "snippet" && <p className="agent-diff-fallback">Reported replacement · line numbers are relative to the supplied snippet.</p>}
    {change.hunks !== null ? <>
      {change.hunks.length ? <ReviewPatch path={change.path} hunks={change.hunks} /> : <p className="agent-diff-fallback">No changed text lines were reported.</p>}
      {change.patch && <details className="agent-raw-patch"><summary>View raw patch</summary><pre>{change.patch}</pre></details>}
    </> : change.patch !== null ? <><p className="agent-diff-fallback">{sourceLabel} · line totals unavailable</p><pre className="agent-review-raw" tabIndex={0}>{change.patch}</pre></> : change.source.type === "diff" ? <><p className="agent-diff-fallback">Showing supplied before/after text for this large change.</p><details><summary>Before</summary><pre>{change.source.oldText ?? "New file"}</pre></details><details open><summary>After</summary><pre>{change.source.newText}</pre></details></> : null}
  </div>
}
