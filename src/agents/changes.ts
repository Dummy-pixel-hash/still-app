import { formatPatch, parsePatch, structuredPatch, type StructuredPatchHunk } from "diff"
import type { AgentToolContent } from "./types"
import type { TranscriptItem } from "./transcript"

export type ChangeContent = Extract<AgentToolContent, { type: "diff" | "patch" }>
export type ChangeOutcome = "completed" | "failed" | "pending" | "unconfirmed"
export interface AgentChange {
  id: string
  outcome: ChangeOutcome
  path: string
  source: ChangeContent
  additions: number | null
  deletions: number | null
  patch: string | null
  hunks: StructuredPatchHunk[] | null
}
export type ReportedChange = Omit<AgentChange, "id" | "outcome">
const cache = new WeakMap<ChangeContent, ReportedChange[]>()

function hunkCounts(hunks: StructuredPatchHunk[]) {
  let additions = 0, deletions = 0
  for (const hunk of hunks) for (const line of hunk.lines) {
    if (line.startsWith("+")) additions++
    if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

/** Review provider-reported text, never infer a live Git working-tree status. */
export function describeChanges(source: ChangeContent): ReportedChange[] {
  const previous = cache.get(source)
  if (previous) return previous
  let patch: string | null = source.type === "patch" ? source.patch : null
  let result: ReportedChange[] | undefined
  try {
    if (source.type === "diff" && (source.oldText?.length || 0) + source.newText.length <= 500000) {
      const diff = structuredPatch(source.path, source.path, source.oldText || "", source.newText, undefined, undefined, { context: 3, timeout: 30, maxEditLength: 4000 })
      if (diff) {
        patch = formatPatch(diff)
        result = [{ path: source.path, source, patch, hunks: diff.hunks, ...hunkCounts(diff.hunks) }]
      }
    }
    if (source.type === "patch" && patch !== null && patch.length <= 1000000) {
      const parsed = parsePatch(patch)
      if (parsed.some(file => file.hunks.length || file.isGit)) result = parsed.map(file => {
        const name = file.newFileName && file.newFileName !== "/dev/null" ? file.newFileName : file.oldFileName
        const path = name ? file.isGit ? name.replace(/^[ab]\//, "") : name : source.path
        const hunks = file.isBinary ? null : file.hunks
        return { path, source, patch: parsed.length === 1 ? patch : formatPatch(file), hunks, ...(hunks === null ? { additions: null, deletions: null } : hunkCounts(hunks)) }
      })
    }
  } catch { /* Raw provider patch remains inspectable even when it is not unified diff. */ }
  result ||= [{ path: source.path, source, additions: null, deletions: null, patch, hunks: null }]
  cache.set(source, result)
  return result
}

export function conversationChanges(items: TranscriptItem[]): AgentChange[] {
  const changes: AgentChange[] = []
  for (const item of items) {
    if (item.kind !== "tool") continue
    const outcome: ChangeOutcome = item.status === "completed" ? "completed"
      : ["failed", "error", "cancelled", "canceled", "rejected", "denied"].includes(item.status || "") ? "failed"
        : ["pending", "in_progress", "running", "queued"].includes(item.status || "") ? "pending" : "unconfirmed"
    for (const [index, content] of (item.content || []).entries()) {
      if (content.type === "diff" || content.type === "patch") {
        describeChanges(content).forEach((change, file) => changes.push({ id: `${item.id}:${index}:${file}`, outcome, ...change }))
      }
    }
  }
  return changes
}
export function changeTotals(changes: AgentChange[]) {
  const completed = changes.filter(change => change.outcome === "completed")
  return { files: new Set(completed.map(change => change.path)).size, reportedFiles: new Set(changes.map(change => change.path)).size, attempts: changes.length - completed.length, additions: completed.reduce((n, c) => n + (c.additions || 0), 0), deletions: completed.reduce((n, c) => n + (c.deletions || 0), 0), exact: completed.every(c => c.additions !== null) }
}
