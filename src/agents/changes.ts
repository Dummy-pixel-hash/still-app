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
  preview?: "snippet" | "written"
}
export type ReportedChange = Omit<AgentChange, "id" | "outcome">
const cache = new WeakMap<ChangeContent, ReportedChange[]>()
const inputCache = new WeakMap<object, { output: unknown; path: string | undefined; title: string | undefined; kind: string | undefined; changes: ReportedChange[] }>()

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

function buildToolEdits(item: TranscriptItem): ReportedChange[] {
  const input = item.input || {}
  // Only edit tools supply this fallback. Never parse commands, prose, or read
  // results as filesystem changes, and never read files to invent a before state.
  if (item.toolKind !== "edit" && !/^(?:edit|write|multiedit|apply_patch|applypatch|replace)(?:\b|_)/i.test(item.title || "")) return []
  const path = [input.path, input.file_path, input.filePath, item.locations?.[0]?.path].find(value => typeof value === "string" && value.length) as string | undefined
  const output = item.output && typeof item.output === "object" && !Array.isArray(item.output) ? item.output as Record<string, unknown> : {}
  const suppliedPatch = [output.diff, input.patch, input.patchText, input.input].find(value => typeof value === "string" && value.trim()) as string | undefined
  let rawPatch: ReportedChange[] | undefined
  if (suppliedPatch) {
    const fallback = path || "Reported patch"
    const files = describeChanges({ type: "patch", path: fallback, patch: suppliedPatch })
    // Unified patch headers already contain file identities. Requiring a separate
    // path here dropped apply_patch tools which supply only a patch argument.
    if (files.some(file => file.hunks !== null || file.path !== fallback)) return files
    if (suppliedPatch.length <= 1_000_000 && /^\*\*\* Begin Patch\r?$/m.test(suppliedPatch)) {
      const records = [...suppliedPatch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+?)\r?$/gm)]
      const edits = records.map((record, index) => {
        const patch = suppliedPatch.slice(record.index, records[index + 1]?.index ?? suppliedPatch.length)
        const name = /^\*\*\* Move to: (.+?)\r?$/m.exec(patch)?.[1] || record[1]
        // Keep provider-specific patches raw; do not invent unified line numbers.
        return { path: name, source: { type: "patch" as const, path: name, patch }, patch, hunks: null, additions: null, deletions: null }
      })
      if (edits.length) return edits
    }
    if (path) rawPatch = files
  }
  if (!path) return []
  const operations = Array.isArray(input.edits) ? input.edits : [input]
  const snippets: ReportedChange[] = []
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") continue
    for (const [before, after] of [["oldText", "newText"], ["old_string", "new_string"], ["oldString", "newString"]]) {
      if (typeof operation[before] !== "string" || typeof operation[after] !== "string") continue
      const source: ChangeContent = { type: "diff", path, oldText: operation[before], newText: operation[after] }
      snippets.push(...describeChanges(source).map(change => ({ ...change, preview: "snippet" as const })))
      break
    }
  }
  if (snippets.length) return snippets
  if (rawPatch) return rawPatch
  const written = input.content
  if (typeof written === "string" && /write/i.test(item.title || "")) {
    return [{ path, source: { type: "diff", path, newText: written }, additions: null, deletions: null, patch: null, hunks: null, preview: "written" }]
  }
  return []
}

function suppliedToolEdits(item: TranscriptItem): ReportedChange[] {
  const key = item.input || (item.output && typeof item.output === "object" ? item.output : undefined)
  if (!key) return []
  const path = item.locations?.[0]?.path
  const saved = inputCache.get(key)
  if (saved && saved.output === item.output && saved.path === path && saved.title === item.title && saved.kind === item.toolKind) return saved.changes
  const changes = buildToolEdits(item)
  inputCache.set(key, { output: item.output, path, title: item.title, kind: item.toolKind, changes })
  return changes
}

export function conversationChanges(items: TranscriptItem[]): AgentChange[] {
  const changes: AgentChange[] = []
  for (const item of items) {
    if (item.kind !== "tool") continue
    const outcome: ChangeOutcome = item.status === "completed" ? "completed"
      : ["failed", "error", "cancelled", "canceled", "rejected", "denied"].includes(item.status || "") ? "failed"
        : ["pending", "in_progress", "running", "queued"].includes(item.status || "") ? "pending" : "unconfirmed"
    const edits = (item.content || []).filter((content): content is ChangeContent =>
      "path" in content && typeof content.path === "string" && !!content.path && (content.type === "diff" && typeof content.newText === "string" && (content.oldText == null || typeof content.oldText === "string")
        || content.type === "patch" && typeof content.patch === "string" && !!content.patch.trim()))
    if (edits.length) for (const [index, content] of edits.entries()) {
      describeChanges(content).forEach((change, file) => changes.push({ id: `${item.id}:${index}:${file}`, outcome, ...change }))
    }
    else suppliedToolEdits(item).forEach((change, index) => changes.push({ id: `${item.id}:input:${index}`, outcome, ...change }))
  }
  return changes
}
export function changeTotals(changes: AgentChange[]) {
  const completed = changes.filter(change => change.outcome === "completed")
  return { files: new Set(completed.map(change => change.path)).size, reportedFiles: new Set(changes.map(change => change.path)).size, attempts: changes.length - completed.length, additions: completed.reduce((n, c) => n + (c.additions || 0), 0), deletions: completed.reduce((n, c) => n + (c.deletions || 0), 0), exact: completed.every(c => c.additions !== null) }
}
