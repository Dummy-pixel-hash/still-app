# Specification 04 — read-only remote Git review

Roadmap: **AG-02a**. Milestone B; independent of provider inference and Gemini access.
Mode: **Operate** — inspect the checkout the selected conversation is using.

## Outcome

A manual edit made on the server appears in Still's Changes inspector. Multiple
agent edits collapse into the current cumulative diff. The user can distinguish
current repository contents from the historical edits reported by a conversation.

The first slice supports inspection. Stage/commit/push/PR and review comments remain
AG-02b/c. No forge credentials or new dependency is needed for this slice.

## Reuse map

| Existing source | Use |
| --- | --- |
| `src-tauri/src/ssh_worker.rs::open_agent_exec` | Verified/authenticated SSH connection, separate non-PTY exec channel |
| `src-tauri/src/agent.rs::{quote,directory_script,remote_cwd}` | Existing command/path validation patterns; share minimally where necessary |
| `src/bridge/{nativeBridge,tauriBridge,agentMocks}.ts` | Native API contract, production IPC, explicit unsupported browser adapter |
| `src/components/{RemoteAgentWorkspace,AgentWorkspace}.tsx` | Selected host, canonical conversation cwd, live native connection |
| `src/components/AgentChanges.tsx` | Changes layout, file selector, narrow-screen drawer/focus behavior |
| `src/agents/changes.ts` and `diff` | Existing unified patch parsing and counts; keep history projection separate |
| `src/components/AgentMessage.tsx::AgentChangeView` | Diff display, line numbers, and syntax rendering |

Proposed small additions: `src-tauri/src/agent_git.rs`,
`src-tauri/agent-host/git-review.mjs`, `src/agents/git.ts`,
`src/session/agentGit.ts`, and `src/components/AgentRepositoryChanges.tsx` only if
separating repository content keeps the existing inspector simple. These have
specific callers; do not add a general command runner or repository plugin layer.

## Identity and API

Add two methods to `NativeBridge` and corresponding Tauri commands:

```ts
agentGitStatus(nativeSessionId: string, cwd: string): Promise<AgentGitSnapshot>

agentGitDiff(
  nativeSessionId: string,
  cwd: string,
  request: { snapshotId: string; entryId: string; view: "combined" | "staged" | "unstaged" }
): Promise<AgentGitDiff>
```

Native command names: `still_agent_git_status`, `still_agent_git_diff`.
Native resolves the account/host from its authenticated session state. The renderer
cannot substitute a claimed host identity, arbitrary repository root, Git flags,
object expression, or filesystem path in a diff request.

`cwd` must be the deliberate selected conversation's canonical execution directory.
Resolve the containing worktree root even when the selected project is a subfolder.
Display that root visibly so reviewing files elsewhere in that same repository is
explicit. A user-initiated repository refresh does not need a running model.

```ts
interface AgentGitEntry {
  id: string
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
  kind: "modified" | "added" | "deleted" | "renamed" | "copied"
    | "untracked" | "conflicted" | "submodule" | "typeChanged"
  additions: number | null
  deletions: number | null
  binary: boolean | null
}

type AgentGitSnapshot = {
  schemaVersion: 1
  snapshotId: string
  hostKey: string
  cwd: string
  observedAt: number
} & (
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

interface AgentGitDiff {
  snapshotId: string
  entryId: string
  view: "combined" | "staged" | "unstaged"
  observedAt: number
  state: "ready" | "binary" | "tooLarge" | "conflict" | "submodule"
    | "symlink" | "unsupportedPath" | "stale"
  path?: string
  patch?: string
  reason?: string
}
```

Native snapshot/entry IDs are opaque lookups into a **bounded in-memory native
registry**, not new durable repository records. Store the selected native connection,
actual host, canonical cwd/root, HEAD/index identity, and a bounded file-list
fingerprint for each snapshot. At most **16 snapshots**, **5-minute TTL**; evict on
disconnect or connection replacement. Entries and raw path bytes remain native-owned.
Unknown/expired snapshot is a stale response, not a new implicit selection.

Lazy eviction at the next Git request is sufficient if every read first checks the
actual selected handle is live and rejects disconnected/replaced connection IDs.
Reuse current connection state; a new background registry-cleanup service is unnecessary.

`path` is required for a resolved entry; it may be absent only for an expired or
unknown snapshot/entry. That response uses the supplied validated IDs solely to
identify the stale request, never to select a new file. The renderer keeps its last
readable label and offers Refresh.

### Helper wire boundary

Export `inspectGit(request)` from the bundled helper. Native sends a single bounded
JSON envelope `{ source, request }` to a fixed short Node loader on SSH stdin, then
sends EOF. `source` comes from the application's bundled `include_str!` content,
never IPC/renderer input. The loader imports that trusted source and writes one
framed JSON result with a fixed prefix; native tolerates bounded login-shell banners
before the prefix and validates the result before exposing it to the renderer.

The internal request is either `{ operation: "status", cwd }` or
`{ operation: "diff", cwd, root, fingerprint, entry, view }`. The latter's root,
fingerprint, and entry come only from the native snapshot registry. Internal entries
carry base64-encoded exact path bytes and bounded file signatures. The helper
returns public status/diff data plus this private mapping/fingerprint; native keeps
private fields out of renderer responses and assigns the opaque snapshot/entry IDs.

Use a maximum **256 KiB request** (bundled source plus one request), a maximum
**2 MiB decoded response**, and **16 MiB total retained native cache** in addition
to the snapshot count/TTL. Evict oldest snapshots to remain within both limits.
Framing is a transport detail and requires no new reusable framework.

## Remote execution

Use one short-lived, bundled **Node stdlib** helper through `open_agent_exec`; remote
Node >=20 already belongs to the Agents host contract. Git executes remotely, not
against the local checkout and not through a terminal's PTY.

- Stream the bounded helper/request via stdin using a short fixed launcher, ending
  helper input before reading its framed JSON result. Do not concatenate repository
  content, shell snippets from the renderer, or growing bundled files into SSH argv.
- The helper uses `spawn`/`execFile` with fixed executable + argument arrays. Reuse
  one internal `runGit` helper for status and diff, timeout, and byte accounting.
- Set `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `LC_ALL=C`.
  Clear inherited repository-selection environment such as `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and command-injected `GIT_CONFIG_*` values.
- Pass `--no-pager`, disable color, `--no-ext-diff`, `--no-textconv`, and use literal
  pathspec handling. Never invoke external diff helpers, hooks, pagers, or shell
  commands supplied by repository config.
- Disable `core.fsmonitor` per invocation. Before working-tree inspection, read the
  bounded filter-driver configuration and shadow each configured external
  `clean`, `smudge`, and `process` command with an empty per-invocation override and
  `required=false`; no global/project config is written. `--no-textconv` alone does
  not disable clean/process filters. If a file uses such an external filter, retain
  its status entry with unknown counts and an explicit metadata-only preview reason
  in this slice; do not label a raw unfiltered comparison as the normal Git diff.
- Preserve normal Git ownership errors. Do not auto-add `safe.directory` or change
  global/local Git configuration.
- Paths passed to Git are validated stored entries. Preserve bytes through
  machine-readable output and IDs; display-escaped labels are never executable paths.

## Status collection

Use Git's stable formats:

- Resolve worktree/root with `rev-parse` from the chosen cwd. Bare repositories are
  reported as non-reviewable with a concise reason.
- Read branch/HEAD state with machine-readable Git commands. Detached HEAD and
  unborn repositories are valid states; no branch named `main` is fabricated.
- Parse `status --porcelain=v2 --branch -z --untracked-files=all` as NUL-delimited
  bytes. Handle ordinary, rename/copy two-path, unmerged, untracked, and submodule
  records. Do not split filenames on whitespace or newlines.
- Obtain combined tracked-file counts from `diff --numstat -z` against HEAD for an
  existing commit, with bounded rename detection. Binary `-` counts become `null`,
  not zero. Match numstat rename records using their two paths. Unborn combined
  counts may stay unknown until an individual new-file preview is requested.
- Preserve index/worktree XY values so a path staged and modified again shows both
  facts. Conflict/submodule summary must not become a normal successful text diff.
- Counts are optional for untracked content until requested. Status collection must
  not read every untracked large file just to populate the file list.

Use `-M` with a rename limit of **200** for tracked diff/numstat; configure matching
status rename behavior with per-invocation options. Above the limit, additions and
deletions are acceptable instead of guessed renames. Parse copy records when Git
reports them, without requesting expensive exhaustive copy detection.

For an unborn repository, `git diff --cached` without a commit argument provides the
staged view. Combined per-file previews compare an empty base to the bounded current
file via fixed `git diff --no-index -- /dev/null <stored-path>` arguments; treat exit
1 as “differences”, not failure. A staged-then-deleted new file has an empty combined
result. Do not write an empty tree object or hard-code a SHA-1-only object ID.
Repositories using SHA-256 remain valid.

### Limits and errors

- Complete status/diff operation: **10-second deadline**, close channel/child on
  timeout. Retained stderr <= **16 KiB**; user-facing reason <= **500 characters**.
- Status wire output <= **2 MiB**, <= **2,000 entries**. Stop decoding at complete
  record boundaries; flag `truncated: true`. Never show a truncated clean result as
  “No changes”. No automatic higher-limit retry.
- Reserve response space for metadata and private path mappings before accepting
  another entry. A raw Git subprocess limit truncates the file listing at complete
  records; a malformed/over-limit final JSON response is a native error, never a
  partially parsed success. The aggregate budget includes base64 path expansion.
- Diff <= **512 KiB** UTF-8 patch and **10,000 lines**; over-limit files return
  `tooLarge` without feeding an invalid cut patch to the renderer.
- Missing Git, nonrepository folder, timeout, SSH loss, wrong ownership, malformed
  output, and stale selection have distinct visible states. SSH errors remain
  connection errors, not “Not a Git repository”.
- Filenames that are valid UTF-8, including spaces, tabs, newlines, leading dashes,
  quotes, and shell metacharacters, must round-trip exactly. Escape control
  characters only in the display label. For invalid UTF-8 path bytes, retain their
  opaque native ID, display an explicit escaped label, and return `unsupportedPath`
  for content in this slice rather than reading a different replacement-character
  path. Do not silently omit them from status.

## Diff views and freshness

| View | Meaning |
| --- | --- |
| `combined` | Current tracked working-tree contents versus HEAD, including staged plus unstaged effects |
| `staged` | Index versus HEAD |
| `unstaged` | Working tree versus index |

Untracked paths appear separately and offer a bounded new-file preview from empty
content. Read only a regular file inside the selected root; do not follow an
untracked symlink outside it. A symlink can show its link target as metadata. A
submodule is a summary, not recursion into a second repository.

Use the stored original/destination paths for rename diffs. Row identity and labels
come from the status mapping, not parsed patch headers (which may be quoted). Feed
only complete bounded patches to the existing `diff` parser. Expose the existing
plain patch-rendering component or add a small optional source label if necessary:
repository fallback copy must not call it an “Original provider patch”.

An untracked preview appears in Combined and Unstaged; Staged shows no staged
changes for that entry. On born/unborn repositories alike, absent content is distinct
from a read error. Use `state: "symlink"` with bounded escaped target metadata,
`submodule` for a gitlink summary, and `unsupportedPath` with a reason for an invalid
UTF-8 path or external-filtered file. None is silently represented as an empty patch.

On each diff request:

1. Resolve the native cached snapshot and entry; validate connection/host/cwd/root.
2. Recheck HEAD/index and a fresh status fingerprint. If they differ, return stale.
3. Compute the requested diff using only the stored path(s). Recheck the identity
   and selected-file signature afterward. Retry **once** for a racing edit, then
   return stale if it is still changing.
4. Stamp the diff observation time. Current files can change during inspection;
   this is a best-effort read snapshot, not a transaction or a future mutation token.

Do not advertise `snapshotId` as a lock on the checkout. Later staging/commit work
must independently validate content at mutation time. External edits can happen
outside Still's observation boundaries.

Build the private fingerprint from resolved Git-directory identity, HEAD (including
unborn state), bounded index identity, and raw status records. Save per-entry
`lstat` identity/size/nanosecond mtime/ctime when collecting status; compare the
selected entry before and after its read. Working-tree XY text alone cannot detect
two different edits that both have status `M`. File signatures are best-effort race
detection, not cryptographic content approval for later mutations.

## Renderer lifecycle

Use a small per-selected-context hook/state owner (`agentGit.ts`) with:

- `idle`, `loading`, `ready`, `error`, and stale-with-last-value states;
- one in-flight status read per selected context and a monotonically increasing
  local request generation;
- result scope `(hostKey, nativeSessionId, cwd, selected conversation)`;
- latest-read retention on failure and generation checks on all async completion;
- selected diff cache only for its native snapshot ID, entry, and view.

Refresh when the **Repository** view opens, on explicit Refresh, on successful
reattach, and once after a known turn boundary while the view is visible. A grouped
edit-tool completion may mark the view stale. Do not run Git per token/tool output
chunk or run a new interval while the inspector is closed. Edits made by another
server process appear after Refresh; a filesystem watcher is unnecessary here.

On context change, immediately stop presenting the previous project's live data;
discard late replies by generation. In-flight requests may finish remotely but
cannot populate the new context. Offline snapshots stay in memory with “Last
checked…”; native conversation journals do not persist whole Git patches.

## Inspector UX

- Existing **Changes** opens the inspector with two real views: **Repository** and
  **Conversation**. Repository is the default for the header entry. Clicking the
  in-transcript provider-edit summary opens Conversation explicitly.
- Repository header shows branch or short detached HEAD, canonical root, last-check
  state, and Refresh. Show the selected server label through the existing context.
- File list shows XY-derived staged/unstaged/untracked/conflict state and known
  additions/deletions. Scope tabs are **Combined**, **Staged**, **Unstaged**.
- Use the existing diff renderer for complete text patches. For binary, too-large,
  untracked preview, symlink, submodule, conflict, and unsupported-path responses,
  show explicit content-specific explanations.
- Clean repository: “No uncommitted changes.” Non-Git project: “This folder is not
  inside a Git working tree.” Conversation remains usable in either case.
- Retain existing side-by-side layout above 1000px and dismissible compact drawer,
  focus management, Escape, inert background, reduced motion, and scroll positions.
- Use semantic buttons/tabs with keyboard focus and visible selected state. Counts
  in the historical conversation summary remain historical, not repository totals.

## Acceptance IDs

| ID | Observable result |
| --- | --- |
| GIT-AC1 | Manual remote edits appear; nested cwd resolves correct root; detached/unborn/non-Git cases are explicit |
| GIT-AC2 | Staged + unstaged + untracked, rename/copy, delete, binary, conflict, and submodule states parse correctly |
| GIT-AC3 | Host/cwd/connection switches and late requests cannot leak another project's result |
| GIT-AC4 | External diff/textconv/pager/selection environment cannot run unintended helpers or select another repository |
| GIT-AC5 | Awkward filenames round-trip, invalid UTF-8 is explicit, and symlinks cannot cause an outside-file read |
| GIT-AC6 | Byte/entry/line/deadline limits are enforced with no fake clean result or invalid rendered patch |
| GIT-AC7 | A stale/racing selected diff produces a stale state; no silent current-content claim |
| GIT-AC8 | Repository and Conversation views retain distinct meaning, keyboard operation, and compact drawer behavior |
| GIT-AC9 | Git reads use the agent's authenticated non-PTY connection and leave HEAD/index/working files unchanged |

Focused fixtures, remote checks, and packaged native requirements:
[VERIFICATION.md](VERIFICATION.md).
