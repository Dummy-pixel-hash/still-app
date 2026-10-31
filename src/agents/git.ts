export type AgentGitEntryKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "submodule" | "typeChanged"
export type AgentGitView = "combined" | "staged" | "unstaged"

export interface AgentGitEntry {
  id: string
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
  kind: AgentGitEntryKind
  additions: number | null
  deletions: number | null
  binary: boolean | null
}

interface AgentGitSnapshotBase {
  schemaVersion: 1
  snapshotId: string
  hostKey: string
  cwd: string
  observedAt: number
}

export type AgentGitSnapshot = AgentGitSnapshotBase & (
  | { state: "notRepository" | "gitUnavailable"; reason: string }
  | {
      state: "ready"
      root: string
      headOid: string | null
      branch: string | null
      detached: boolean
      unborn: boolean
      entries: AgentGitEntry[]
      truncated: boolean
    }
)

export interface AgentGitDiff {
  snapshotId: string
  entryId: string
  view: AgentGitView
  observedAt: number
  state: "ready" | "binary" | "tooLarge" | "conflict" | "submodule" | "symlink" | "unsupportedPath" | "stale"
  path?: string
  patch?: string
  reason?: string
}
