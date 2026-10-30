# Agents feature implementation plan

Updated: **2026-10-30**. Feature status and delivery order live in the
[master tracker](README.md). Every unchecked item below is future work.

## Shared implementation rules

- **Identity:** a conversation is the durable local identity; an execution is a
  particular server-side attempt; a provider session is owned by its provider.
  Preserve all three when resuming, forking, importing, queuing, or opening a view.
- **Execution context:** use the selected account/host and canonical remote folder.
  Repository root, worktree path, and display project name are separate facts.
- **Authority:** provider/worker acknowledgements establish execution facts. A UI
  click, a quiet terminal, or a missing event does not establish completion.
- **Persistence:** extend the native metadata/history and remote journal only for
  the facts the feature needs. Preserve drafts and uncertain-operation recovery.
- **Capability:** derive support from the running integration and version. Treat
  unavailable data as unknown, rather than a made-up default or a functioning button.
- **Verification:** use focused state/protocol tests and the existing browser
  fixtures. Real SSH/provider behavior and Windows native behavior need separate
  checks when touched. New functionality must remain keyboard-accessible and usable
  at compact window sizes.

## AG-01 Agent-driven orb

The full specification and checklist are in [agent-orb.md](agent-orb.md).

Deliver the shared conversation-status projection, persistent unread markers,
background observation, versioned native orb metadata, and conversation activation.
This also supplies the status/read-state foundation for AG-05.

## AG-02 Live Git review and delivery

**Current:** `src/agents/changes.ts` computes provider-reported patches.
`src/components/AgentChanges.tsx` presents them as historical activity. Neither
represents the current remote Git working tree.

### Tasks

- [ ] **AG-02a — Read-only repository review.** Resolve the Git root from the selected
  remote folder; expose HEAD/branch, staged/unstaged/untracked paths, additions,
  deletions, renames, binary-file summaries, and a cumulative live diff. Include
  loading, non-Git, detached-HEAD, offline, and stale-snapshot states. Refresh on
  demand and after known agent/mutation boundaries; avoid per-token Git subprocesses.
- [ ] **AG-02b — Git delivery.** Add selected-file stage/unstage, commit, push, and
  explicit PR creation after checking actual Git/forge availability. Start with a
  GitHub integration using authenticated host tooling when available. Show the
  proposed files/message/branch and report hooks, conflicts, auth failures, and
  unknown outcomes accurately. Reconcile before repeating an uncertain mutation.
- [ ] **AG-02c — Review feedback.** Let the user reference a file/hunk/line in a
  follow-up draft and ask the agent to address it. Retain review text if the diff
  changes, identify stale anchors, and show which revision a comment refers to.

**Implementation:** extend `src/bridge/nativeBridge.ts` and its native adapter;
execute Git on the authenticated host through the existing SSH boundary. Reuse the
existing diff library, syntax rendering, and Changes surface. Keep a clear choice
between **current repository changes** and **conversation edit history**.

Commands must use validated arguments and canonical paths, bounded output/timeouts,
and machine-readable Git output. Serialize Still-owned mutations per repository and
refresh before applying a destructive or stale action; external tools can still edit
the same checkout. Repository content should be read without invoking external diff
helpers. Preserve failures from Git hooks rather than bypassing them.

**Done when:** a manual server-side edit appears in live review; multiple agent edits
collapse into the final diff; a stale selection cannot silently stage different
content; commit/push/PR failures remain retryable without duplicate delivery. Plain
chat still works in a non-Git project.

## AG-03 Remote worktree isolation

**Current:** each conversation uses its project folder. Multiple conversations can
edit the same checkout.

### Tasks

- [ ] **AG-03a — Select execution location.** Offer the existing checkout or a new
  remote worktree, with a base branch and proposed branch/name. Detect other active
  Still conversations using the same checkout and explain shared-folder execution.
- [ ] **AG-03b — Create and prepare.** Create the worktree on the selected SSH host,
  record repository/branch/path ownership, and run explicitly configured setup.
  Prepare the provider in the acknowledged worktree directory before its first
  prompt. Setup failure preserves the worktree and provides retry/inspection.
- [ ] **AG-03c — Handoff and lifecycle.** List managed worktrees; open their
  conversations/terminal; support explicit merge or handoff and inspect conflicts.
  Remove only a selected, verified Still-owned worktree after accounting for dirty
  files, untracked files, unmerged commits, and active executions.

**Implementation:** build on AG-02a repository identity and the existing launch
`cwd`/conversation metadata. Keep the logical project distinct from the execution
worktree so sidebar organization survives cleanup. Existing user-created worktrees
can be selected without claiming that Still owns their lifecycle.

**Done when:** simultaneous tasks have independent files; setup/restart retains the
correct execution path; deletion cannot remove an active or user-owned checkout;
merge conflicts stay inspectable. Non-Git projects have an explicit same-folder path.

## AG-04 Attachments and file context

**Current:** `agentSend(executionId, message)` and the provider adapters send text.
The terminal already has clipboard-image and SFTP-upload plumbing to evaluate for reuse.

### Tasks

- [ ] **AG-04a — Message-parts contract.** Extend messages end-to-end for text, images,
  files, and remote file/line references. Define stable attachment identities,
  supported media/size limits, persistence, and a capability-gated mapping for each
  provider. Keep existing saved text messages compatible.
- [ ] **AG-04b — Attachment intake.** Support paste, file picker, and drag/drop with
  preview, remove, progress, failure, and retry. Reuse `readClipboardImageFile` and
  the authenticated upload path where suitable; agent upload must work without a
  terminal card or sending a path through a PTY.
- [ ] **AG-04c — Remote context selection.** Add remote file search and `@file`/line
  selection with canonical project/worktree paths and bounded reads. Check path
  traversal and symlink resolution against the selected access scope.
- [ ] **AG-04d — Delivery and retention.** Preserve text and attachments across
  navigation/restart and failed submission. Bind staged uploads to the correct
  host/project; send only after required uploads succeed. Define cleanup for owned,
  abandoned uploads and reference retention for history/export.

**Implementation:** `src/components/AgentWorkspace.tsx`, `src/agents/types.ts`,
`src/session/agentThreads.ts`, native bridge/agent transport, and
`src-tauri/agent-host/bridge.mjs`. Upload and media validation belongs at the native
boundary as well as in the UI. Providers that can only consume file paths must say
so; unsupported image input must not be presented as successfully delivered vision input.

**Done when:** a native Windows screenshot can reach a supported remote provider;
changing projects cannot send it to the previous host; upload/send failures preserve
the draft; unsupported attachments have a clear explanation. Restored history shows
the attachment or an explicit unavailable-file state.

## AG-05 Agent inbox and notifications

**Current:** conversation status is visible within Agents. There is no shared
attention inbox or agent-completion notification route.

### Tasks

- [ ] **AG-05a — Inbox.** Add a compact Agents view for needs-input, running,
  failed/recovery-needed, and unread-finished conversations across projects. Reuse
  AG-01's status and unread projection; retain project/provider context.
- [ ] **AG-05b — Read state.** Mark a result read when it is actually viewed in the
  focused window or explicitly marked read. Seeing a pending request does not
  approve it or remove its unresolved status. Preserve markers across restarts.
- [ ] **AG-05c — Optional notifications.** Provide opt-in desktop notifications and
  sound, with independent preferences. Deduplicate by stable event identity, suppress
  notices for the result being actively viewed, and open the exact conversation.
  Replayed history updates the inbox without a burst of duplicate system alerts.

**Implementation:** use `src/session/agentThreads.ts` and native conversation
metadata plus the existing Agents navigation. Reuse the orb's activation path for
notification clicks. A notification implementation should use the existing native
platform boundary; select its mechanism when building rather than adding a dependency
as part of this plan.

**Done when:** an approval in an unfocused conversation appears in the inbox and orb;
handling it clears both consistently; a completion produces at most one eligible
notification; archived background work and offline/unknown states remain discoverable.

## AG-06 Queued follow-ups and steering

**Current:** sending is disabled during a turn and the native runner rejects busy
submissions. That guard must remain effective for ordinary sends.

### Tasks

- [ ] **AG-06a — Durable queue.** Add an explicit queue action and ordered entries
  with edit/remove/pause. A server-side worker owns execution of acknowledged queued
  requests so the queue can continue after the laptop disconnects. Client-only drafts
  must not be labelled remotely queued.
- [ ] **AG-06b — Submission contract.** Assign stable request IDs, journal enqueue
  acknowledgements and execution receipts, and preserve the chosen model/settings
  and attachment references. Start the next item only after a confirmed eligible
  turn boundary. Reconcile uncertain receipt instead of blindly resending.
- [ ] **AG-06c — Steering.** Expose an independent “steer current turn” action only
  when the provider supports it. Preserve its acknowledgement and timeline identity;
  ordinary queueing is not an implicit interrupt/restart.
- [ ] **AG-06d — Recovery controls.** Pause queued execution after failure, refusal,
  limits, unknown outcomes, or user stop until an explicit continuation decision.
  Distinguish stopping the current turn from removing future queued requests.

**Implementation:** extend `src-tauri/agent-host/supervisor.mjs`, the native agent
protocol, and existing submission state. AG-04a provides a common payload shape;
AG-11a gates steering. Validate resumed settings against the provider before dispatch.

**Done when:** two queued requests execute once and in order after client disconnect;
restart/replay does not duplicate them; cancellation and editing cannot race an
already-dispatched entry; failure pauses follow-up execution with drafts intact.

## AG-07 Execution-policy controls

**Current:** Still handles provider permission requests and exposes some configuration.
The active sandbox/network/approval policy is not consistently visible.

### Tasks

- [ ] **AG-07a — Effective policy.** Show the policy actually reported by the running
  provider, its scope, and whether it is inherited, editable, or unavailable.
- [ ] **AG-07b — Acknowledged changes.** Expose supported policy choices before the
  first prompt and while idle. Reflect a selection only after acknowledgement; show
  failures without changing the effective state or submitting a draft.
- [ ] **AG-07c — Permission choices.** Preserve real one-shot/session/rule choices
  offered by the provider. Explain unavailable persistent choices and expose current
  settings through the existing Agents controls.

**Implementation:** extend existing `AgentConfigOption`/discovery where it fits and
provider-specific initialization/configuration in `bridge.mjs`; reuse the request UI.
For example, the current Codex catalog publishes model/effort, so a generic fixture's
Ask/Code picker does not establish real Codex policy or mode support.

**Done when:** the UI can show the real effective setting and its source; rejected
updates remain rejected in the UI; unsupported policy changes stay unavailable.
Agent policy controls preserve separate SSH credential and host-key decisions.

## AG-08 Usage and context visibility

**Current:** no typed user-facing usage model. The Rust update filter recognizes
`usage_update`, but its dispatch does not retain or present that payload.

### Tasks

- [ ] **AG-08a — Normalize data.** Preserve provider-reported per-turn/session usage,
  context occupancy/capacity, and account limits with source/time/scope. Distinguish
  cumulative counters from deltas and unknown values from zero.
- [ ] **AG-08b — Display.** Add a compact context/usage control with details for
  input/output/cache categories, provider limits and reset times, and reported cost
  where available. Avoid double-counting cached/reasoning tokens across providers.
- [ ] **AG-08c — Compaction and replay.** Reflect acknowledged context compaction and
  provider refreshes; replay must not increment already-counted usage. Total billed
  tokens and current context occupancy are separate measures.

**Implementation:** extend agent event/snapshot types, adapter events, native
persistence, and composer details. Use installed provider data; avoid invented
pricing, inferred quota resets, or a generic percentage when the denominator is unknown.

**Done when:** values match a real supported provider; compaction updates context
without rewriting historic usage; unsupported/missing values are labelled; replay
and resume do not inflate counters.

## AG-09 File checkpoints and rollback

**Current:** Revert/Retry rewinds provider conversation history and keeps project
files. The existing confirmation correctly states that scope.

### Tasks

- [ ] **AG-09a — Capture.** Define checkpoint boundaries and capture recoverable file
  state in an isolated managed worktree. Record included/excluded paths and supported
  tracked/untracked/binary handling. Never silently promise recovery of ignored or
  omitted files.
- [ ] **AG-09b — Preview restoration.** Show the checkpoint and files to restore,
  compare current content with expected content, and detect intervening user edits.
  Automatic restoration initially requires an isolated Still-owned worktree.
- [ ] **AG-09c — Recoverable execution.** Journal the steps and acknowledgements for
  file restoration and any associated provider-history change. Keep recovery data
  if either step fails; an incomplete operation must not be presented as a completed
  rewind or trigger an automatic retry prompt.
- [ ] **AG-09d — Clear actions.** Keep conversation-only Revert distinct from file
  checkpoint restoration. Enforce active-execution/conflict checks and define explicit
  checkpoint retention and cleanup.

**Implementation:** build on AG-02a repository status, AG-03 worktree ownership,
native history operations, and provider capability checks. Avoid repository-wide
reset/clean operations against an arbitrary shared project.

**Done when:** a checkpoint restores the documented files; newer user changes cannot
be silently overwritten; partial failure and process restart retain a clear recovery
state; current conversation-only Revert keeps its existing meaning.

## AG-10 Session import and conversation forks

**Current:** Still resumes sessions already referenced in its own library. It does
not offer provider-session discovery or a general fork interface.

### Tasks

- [ ] **AG-10a — Discover/import.** After an explicit host/project selection, query
  supported provider session/history APIs and preview available sessions. Deduplicate
  by host, provider, and native session identity. Import history into the existing
  native store with provenance and a clear read-only/continuable state.
- [ ] **AG-10b — Execution ownership.** Detect or explain another active controller.
  Do not silently take over a live CLI/provider session or imply that importing
  history attaches its running process. Existing supervisor attachment replaces the
  previous controller; session adoption must account for that behavior.
- [ ] **AG-10c — Fork.** Create a distinct conversation from a selected supported
  boundary, using a real provider fork operation where available. Preserve the
  original conversation, record lineage, and offer an isolated worktree when file
  isolation is desired. State separately which conversation and file state are copied.

**Implementation:** extend provider discovery/adapter operations and native library
metadata. Native provider IDs remain separate from local conversation IDs and new
execution IDs. A provider with no fork API should expose a clear limitation rather
than silently replaying the entire transcript as a supposed native fork.

**Done when:** importing the same session twice is idempotent; offline history is
readable; resuming requires a valid chosen host/session; forks have independent
identities and preserve their source, including after a client restart.

## AG-11 Provider capability clarity

**Current:** discovery, configuration options, command inventories, and history
capabilities already exist. They are the starting point for feature availability.

### Tasks

- [x] **AG-11a — Inventory and smallest contract specification.** Record the installed provider
  version/transport and probe the capabilities needed by the active milestone.
  Specify additions to existing capability data only as needed for turn outcomes, modes/policies,
  attachments, steering, usage, import/fork, checkpoints, child activity, and
  structured todo read/write support. Include supported, unsupported, and unverified
  states with a short reason.
  **Completed 2026-10-30:** [audit and evidence](provider-capabilities.md). Four actual
  native session startups passed; Gemini initialize passed but its account rejected
  session creation. Installed protocols and current status/todo mappings were audited.
  Live capability publication is the explicit AG-11a.1 follow-up below.
- [ ] **AG-11a.1 — Publish observed capabilities.** Extend existing discovery/session
  metadata with verified version/transport and the minimal feature report specified
  in the audit. Preserve source/scope and stale-on-resume behavior; no unfinished
  feature becomes available merely because its provider has an API.
- [ ] **AG-11b — UI explanation.** Add a concise “Supported by this agent” view and
  relevant disabled-action explanations. Refresh it after reconnect/version changes.
  Keep model/command inventories scoped to the real project and provider.
- [ ] **AG-11c — Evidence matrix.** Record an actual handshake plus a representative
  operation for supported capability claims. Cover OpenCode V2, Codex App Server,
  Claude structured streaming, Pi RPC, and Gemini ACP separately. Synthetic fixtures
  verify the UI contract; they do not establish live provider compatibility.

**Implementation:** `src/session/agentDiscovery.ts`, `src/agents/types.ts`,
`src/components/AgentControls.tsx`, `src-tauri/src/agent.rs`, and
`src-tauri/agent-host/bridge.mjs`. Prefer existing configuration/capability fields
over building a separate plugin framework.

**Done when:** the UI and backend agree on feature availability; unsupported
operations cannot dispatch; version changes refresh support; evidence names which
provider versions were verified and leaves the others explicitly unverified.

## AG-12 Subagent visibility

**Current:** tools/plans are displayed, but child-agent activity has no dedicated
identity or navigable presentation. Some adapters already observe task lifecycle
internally; retain useful native data rather than infer it from prose.

### Tasks

- [ ] **AG-12a — Activity model.** Preserve parent/child IDs, provider status, purpose,
  and terminal outcomes from supported protocols; distinguish a child tool/task from
  a resumable child conversation.
- [ ] **AG-12b — Inspection.** Show child progress and output within its parent and
  open a child conversation when the provider actually exposes one. Link back to the
  parent and keep the original conversation selection stable.
- [ ] **AG-12c — Status/control.** Surface unresolved child attention through the
  shared inbox/orb without double-counting parent summaries. Offer child cancellation
  only if supported, and resolve the actual ownership/approval route.

**Done when:** a real supported subagent can be followed from parent to result;
out-of-order child events do not corrupt another child's display; pending child
work is not mistaken for a successfully finished task. This feature is observation
and provider-supported control, not a new cross-provider orchestration engine.

## AG-13 Integrated development tools

**Current:** Open terminal closes Agents and opens the terminal workspace. Changes
has a viewer, but there is no integrated project-file/browser/test workspace.

### Tasks

- [ ] **AG-13a — Terminal drawer.** Reuse the existing terminal and connection
  lifecycle in a drawer bound to the selected project's execution directory. Keep a
  running terminal's identity explicit when switching conversations/worktrees.
- [ ] **AG-13b — File inspection.** Open remote paths/line references in a read-only
  file viewer using the existing syntax renderer and bounded file access. Reuse
  AG-04's path/scope rules and provide binary/large-file states.
- [ ] **AG-13c — Preview.** Open an explicitly selected development URL through
  authenticated remote forwarding where needed. Tie forwarding to a known
  host/project and lifecycle; do not publish remote services to the internet.
- [ ] **AG-13d — Test results.** Show command, run identity, exit status, output, and
  time/revision for verification runs. Keep old results visibly associated with the
  code they tested; an agent claiming “tests passed” is not a recorded test run.

**Done when:** the user can inspect files, run a terminal, review a dev preview, and
read actual test results without losing the chat/draft. Resizing/closing a drawer
preserves intended processes, terminal input/focus, and compact accessibility.

## AG-14 Plan-to-implementation handoff

**Current:** provider plans display, and some providers expose modes. Executing an
approved plan requires a manual mode/message transition.

### Tasks

- [ ] **AG-14a — Plan identity.** Preserve the actionable plan/version and detect
  whether the current provider supports a plan-to-build mode transition.
  Display structured task steps through AG-18's shared todo projection when available;
  retain narrative plans as plan content so the handoff uses the intended version.
- [ ] **AG-14b — Explicit action.** Offer “Implement this plan” with the selected
  plan and effective execution policy visible. Acknowledge required mode changes
  before submitting exactly one implementation request.
- [ ] **AG-14c — Draft and busy behavior.** Preserve an unrelated draft, disable the
  action during incompatible operations, and use AG-06 only when an explicit queued
  handoff is selected. For unsupported transitions, provide an editable follow-up
  draft with an explanation rather than a nonfunctional mode switch.

**Done when:** plan selection maps to the intended version; mode-change rejection
does not send; repeated clicks cannot duplicate implementation; saved plans remain
inspectable after restart.

## AG-15 Portable history and backup

**Current:** history is saved on the device and can be copied as Markdown. Markdown
copy is useful for reading, but is not a restorable conversation backup.

### Tasks

- [ ] **AG-15a — Export format.** Define a versioned manifest with conversations,
  lineage, project metadata, drafts, events, read state, todos with source/revision
  identities, and referenced attachments.
  Make included assets and unavailable remote references explicit. Keep Markdown
  export as the readable format alongside the restorable format.
- [ ] **AG-15b — Validate/import.** Preview contents, validate versions/schema/bounds
  and attachment paths, resolve duplicate identities, and import transactionally.
  Preserve existing history on failure. Restore executions as saved/unverified;
  reconcile host mappings and session availability before connecting.
- [ ] **AG-15c — Backup workflow.** Offer an explicit destination and clear success
  or partial-failure feedback. Export no credentials/private keys; imported executable
  paths or server settings must not silently authorize a process or connection.

**Implementation:** extend `src/session/agentStorage.ts`, native bridge, and
`src-tauri/src/agent_store.rs`; use current native filesystem/storage facilities.
Portable data should not depend on device-specific absolute paths.

**Done when:** a round trip restores the documented data on a fresh profile; duplicate
import is predictable; a malformed/partial bundle cannot overwrite valid history;
imported historic results do not generate fresh completion notifications.

## AG-16 Mobile access

**Current:** there is no production mobile controller or shared conversation service.
A responsive synthetic browser fixture does not provide remote mobile control.

### Tasks

- [ ] **AG-16a — Decide controller architecture.** Document where the authoritative
  conversation library and authenticated control endpoint run, pairing/revocation,
  transport, and whether the desktop must stay online. The minimal initial scope is
  a mobile companion to a running Still controller; independent control while that
  controller is off requires a separately approved server-hosted ownership/sync design.
- [ ] **AG-16b — Read and act.** Provide project/conversation access, progress,
  approval/question responses, and diff review with reconnect/catch-up behavior.
  Reuse stable conversation/event IDs and shared feature capabilities.
- [ ] **AG-16c — Ownership and recovery.** Serialize writes and prevent a second
  client from unknowingly replacing the first controller. Handle revoked pairing,
  controller offline, stale approvals, and duplicate submissions explicitly.

**Done when:** a paired phone can inspect and respond to a real running conversation,
permissions match the controller, reconnect does not duplicate actions, and the UI
clearly reflects the approved controller-availability model. Select the deployment
model in AG-16a before implementation; no new public endpoint is implied by this plan.

## AG-17 Scheduled agent tasks

**Current:** workers persist existing executions; they do not schedule future ones.

### Tasks

- [ ] **AG-17a — Schedule definition.** Let the user explicitly create a recurring
  task with host/project, provider/model, prompt/context, effective policy, timezone,
  schedule, and pause state. Preview upcoming runs. Start with no-overlap execution
  and skip missed runs rather than launching a catch-up burst.
- [ ] **AG-17b — Remote ownership.** Define a per-account server-side scheduler that
  survives client disconnects, creates known worker executions, and records durable
  run identities/receipts. Document process supervision and server-reboot behavior.
- [ ] **AG-17c — Isolation and outcomes.** Use a managed worktree for each Git run;
  define exclusive-folder execution for non-Git tasks. Publish running, blocked,
  failed, and finished results through the same Agents/orb/inbox state.
- [ ] **AG-17d — Controls and recovery.** Support pause, edit, run-now, and removal of
  future scheduling without implicitly deleting history or cancelling active work.
  Expired authentication, pending approvals, and unknown outcomes remain visible and
  pause dependent execution until resolved.

**Done when:** a configured task runs once at the intended server time while the
laptop is disconnected; timezone/DST, overlap, missed-run, pause, and restart cases
have deterministic behavior; results reopen in the correct conversation. Creating
one ordinary prompt must never silently create a recurring task.

## AG-18 Conversation todos and task progress

**Current:** `AgentPlanEntry` has content, status, and optional priority. The app now
has a separate **shared conversation todo list** and a conversation-scoped
`still_todos` tool. The agent is the sole writer: it authors task names, a current
task with optional progress detail, durations, and Done/Not done state. Still shows
the collapsed progress pill (`2/4 Todos done`) above the composer; clicking it opens
the detailed timeline. Native history saves snapshots for offline reading and provider
resume.

Provider-native plan events remain a separate source and are not silently copied
into this checklist. The shared list tracks who last changed each item.

### Tasks

- [x] **AG-18a — Shared source, persistence, and identity.** The shared list uses
  stable IDs, actor, status, order, monotonic revision, durable remote-worker storage,
  idempotency receipts, and replayable native-history snapshots. **Implemented.**
- [ ] **AG-18b — Provider tool integration/evidence.** Register `still_todos` through
  existing provider-native tool routes: Codex App Server `dynamicTools`/`item/tool/call`,
   Claude per-execution MCP config, Pi's explicitly loaded extension, OpenCode's advertised runtime
  MCP route, and Gemini ACP MCP configuration. It provides `list`, `add`, `update`,
  `remove`, `move`, and `focus`, with only `pending`/`completed` statuses; changes require `expectedRevision`. Readiness is surfaced only
  after tool registration/connect. **Code integrated; representative live generated
  model tool calls remain unverified per provider.** Four provider session starts and
  tool registration handshakes passed locally; Codex request translation passed a
  synthetic server request; the worker fixture exercises an authenticated agent-role
  update. Gemini initialization passed, but this account refused session creation.
  Provider-native plan/todo synchronization is separate and not claimed here.
- [x] **AG-18c — Collapsed progress pill and expanded read-only timeline.** Keep the
  normal composer pill unchanged. Show only `done / total Todos done` in a small round
  pill above it. Clicking the pill or chevron expands a full vertical timeline with
  Done/Not done, task names, current detail, and elapsed times; Escape or the chevron
  collapses it. Expansion respects reduced motion and is tested in the browser.
- [x] **AG-18d — Agent-only task changes.** The app exposes no task creation, rename,
  reorder, delete, priority, or status-edit controls. The agent's `still_todos` tool
  owns all changes; the app displays only task names and Done/Not done status.
- [ ] **AG-18e — Persistence and history.** Snapshots persist with native conversation
  history; the private remote store is keyed by conversation identity across provider
  resumes. Verify restart/replay, disconnect, revert, fork/import, and export behavior.
  Existing workers predating protocol v3 show their cached list read-only until a new
  v3 execution is started; they do not understand the custom todo protocol.
- [ ] **AG-18f — Status integration and provider evidence.** Keep todo progress distinct
  from execution status. Test stale revisions, ACK loss, offline restoration, and
  real tool invocation for each installed provider/account. The orb remains deferred;
  todo state must not trigger or clear orb status.
- [ ] **AG-18z — Release verification.** Verify the packaged Windows app, native
  history boundary, and real provider tool calls on an authorized SSH host with named
  versions. Local Linux startup and synthetic tests are not release evidence.

**Implementation:** use `src/agents/types.ts`, the composer dock in
`src/components/AgentWorkspace.tsx`, and the read-only `src/components/AgentTodos.tsx`.
Normalize worker events in `src-tauri/agent-host/bridge.mjs` and
`src-tauri/src/agent.rs`; persist snapshots in the existing native conversation
journal. The app has no task mutation endpoint.

### Implemented shared-tool architecture

- The remote worker owns a private, conversation-keyed `todos.json` store under
  `~/.local/state/still/agent-todos/`; this survives provider-resume execution IDs.
  It uses atomic replacement, bounded
  idempotency receipts, and a monotonic revision. Every model-tool mutation checks
  `expectedRevision`; a stale request must reread and reconcile instead of overwriting.
- The `still_todos` MCP stdio server and Pi extension both call that worker over its
  existing private Unix socket. The socket has user-only permissions and a
  per-worker capability token. No public TCP endpoint is added. The tool does not
  execute shell commands or access project files.
- Codex receives a dynamic function tool, Claude gets a local MCP server, Pi loads
  Still's scoped extension, OpenCode registers a project-scoped runtime MCP server
  when the installed V2 API advertises it, and Gemini receives an ACP `mcpServers`
  configuration. Provider-native plan events remain separate and aren't falsely
  described as synchronized.
- The app's Todos panel is read-only and consumes revisioned worker events. Only
  authenticated agent-tool requests may change task names or binary status. Native
  history saves snapshots for offline viewing; the conversation-keyed remote store
  survives provider resume.
- Existing workers predating worker protocol v3 do not implement the shared Todo
  route; their cached Todos remain visible read-only until a new v3 execution is
  created. Tool availability is distinct from whether a cached snapshot can be read.

**Done when:** app and provider share one revisioned list; old/out-of-order updates
cannot overwrite current work; offline snapshots survive local-history replay; task
completion cannot claim a turn/tests finished; legacy workers show honest read-only
state. UI, native, worker, MCP protocol, and synthetic Codex tool-call checks pass.
Actual model-generated tool-call checks on each provider/account and packaged Windows
verification remain before AG-18 can be marked complete.
Checking the last item cannot trigger a false green orb or claim that tests passed.

## Verification and completion records

For each delivered feature, record:

| Evidence | Required detail |
| --- | --- |
| Implementation | Commit/reference and completed task IDs |
| Automated | Relevant commands and results, including state/protocol failure cases |
| Browser | Real UI interactions, keyboard/focus, compact layout, and fixture limitations |
| Provider | Actual host/runtime/provider version and representative operation, or explicitly unverified |
| Native | Packaged/native checks for clipboard, IPC, focus, notifications, or lifecycle when affected |
| Documentation | Updated current behavior and remaining boundaries |

Use `npm run typecheck`, the relevant `test:agents`, `test:orb`, or `test:terminal`
checks, and targeted Rust checks as the touched implementation requires. Avoid
repeating unrelated suites after the necessary checks pass. The orb's first
milestone has a concrete verification matrix in [agent-orb.md](agent-orb.md).
