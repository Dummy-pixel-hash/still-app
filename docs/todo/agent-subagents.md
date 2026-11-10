# AG-12 — Subagent integration and direct chat

Updated: **2026-11-10**. Status: **IN PROGRESS — create/resume fix and parent-model guide implemented locally; Windows verification pending**.
Feature status and delivery order live in the [Agents tracker](README.md).
The implementation checklist is in [AG-12](agents-roadmap.md#ag-12-subagent-integration).

This specification expands the earlier observation-only AG-12 scope into bounded,
Still-managed cross-agent delegation. It describes intended behavior, not current
provider support or a shipped runtime guarantee.

**Implementation update:** the Still-managed `still_subagents` tool is now registered
through the existing MCP, Codex dynamic-tool, and Pi tool paths. Authenticated requests
are routed through the persistent parent worker and replayed after a transport
reattach; the app handles `list`, cross-agent `spawn`, `inspect`, queued `guide`, bounded
`wait`, and child `cancel`. Parent/child identity is recorded with the child execution.
The child remains directly openable/messageable in the UI, and parent guidance is
serialized with `Parent agent` provenance. Cancellation pauses queued parent guidance
and reports a request rather than claiming confirmed completion. Children cannot spawn
children; a shared-folder limit of three concurrent children is enforced in the app.

The shared tool description/schema now carries the model-facing delegation guide. A
parent can prepare a child, inspect its exact model/effort/mode choices, then spawn it
using validated IDs. New child IDs now select local-history creation unless the request
also supplies an explicit provider session ID for resume; a native unit test covers
that distinction. These corrections are present locally but still need a fresh Windows
ARM64 workflow and real-provider exercise.

**Model and mode controls (2026-11-09):** parents can call `prepare` to start a child
without sending its task and receive that provider's exact model, effort/reasoning, and
mode option IDs. `spawn` validates requested IDs against the prepared child's current
catalog, applies model first and refreshes dependent options, then applies effort/mode
before sending the task. Unsupported selections fail without submitting the task; the
effective selections are returned and shown in the parent panel. Plan/Build are offered
only when that provider advertises those actual modes, never inferred from permission
profiles.

This is an implementation in progress, not a live compatibility claim: provider
tool-call delivery, SSH reconnect behavior, packaged Windows behavior, and actual
cross-provider sign-in have only fixture/build coverage so far. Pending tool requests
and app-owned operation metadata also need broader restart/crash recovery validation.

## Resolved locally; Windows/provider verification pending: child ID was treated as resume

**Reported 2026-11-10:** preparing/spawning a subagent on Windows displays:

> Conversation changes could not be saved on this device: The system cannot find the
> file specified. (os error 2)

The user confirmed this occurs during subagent preparation/spawning, not an ordinary
main-chat message. This is a local conversation-history failure, not evidence that a
remote task stopped. Do not recommend deleting history or resending the original task.

### Code-path finding

- `src/components/AgentWorkspace.tsx` assigns a new child a stable
  `subagent-...` conversation ID and passes it to the native start request.
- `src-tauri/src/agent.rs` treated any supplied `conversation_id` as a resume:
  it loads an existing snapshot before creating the new child history.
- The new child's history does not yet exist. `agent_store::load_snapshot` can therefore
  return the missing-file error wrapped as a generic conversation-storage failure.
- The same create/resume assumption also controls registration and history restoration.
  Fixing only the initial load would leave the startup contract inconsistent.

This was caused by treating any caller-assigned local conversation ID as a resume
request. A stable new child ID had no local history file, so the resume path attempted
to load a nonexistent snapshot and surfaced Windows `os error 2`.

### Required correction

1. Distinguish **create with a caller-assigned ID** from **resume an existing provider
   session**. A stable conversation ID alone is not a request to resume.
2. For a new child, register its local history exactly once before subsequent metadata
   writes. Preserve its parent, host, folder, and agent identity.
3. For a resume, require the explicit saved provider-session identity and validate its
   existing history/scope. Do not silently convert missing resume history into a fresh
   worker or replacement conversation.
4. Apply the same intent consistently to snapshot loading, registration, prior-message
   restoration, Todo seeding, and provider recovery. Preserve tombstones and leases.
5. On retries, reconcile the stable operation/conversation identity rather than spawning
   another child or replaying its task. Keep uncertain delivery distinct from failure.
6. Give storage errors operation-specific context and the relevant local path, so a
   missing snapshot can be distinguished from failed creation, access, or persistence.

**Implemented locally (2026-11-10):** native start now distinguishes an explicit resume
(both saved local conversation ID and confirmed provider session ID) from a new
conversation with a caller-assigned ID. Only explicit resumes load saved snapshots,
recover prior Todos/messages, and register as resumes. New prepared children register
their history as a create. Native tests cover the intent matrix. Browser tests alone
would not have caught this mismatch.

Still verify a real prepare/spawn on the affected Windows build; the latest recorded
ARM64 workflow predates this correction. Keep create failure/tombstone/lease recovery
and crash-retry behavior in the remaining acceptance tests.

## Agreed product decisions

- Any eligible installed/configured agent can delegate to another agent on the
  **same account/host and canonical project folder**, including a different provider.
  For example, Claude can delegate to Codex. Eligibility depends on the integrated
  runtime and authentication, not just an executable being present.
- **One level only:** a main conversation can create children; those children cannot
  create further Still-managed subagents, even when opened directly by the user.
- **Always share the project folder.** Do not create a worktree or branch implicitly.
- Show each parent's children in a compact, comfortable box at the upper right of
  its chat, including the child title, agent identity, and actual status.
- **The user can enter the subagent's actual chat and talk to it directly.** This is
  a first-class child conversation with a composer, not a read-only output viewer
  or a requirement to relay every instruction through the parent.
- The parent can inspect, guide, wait for, and stop its own children through shared
  Still tools. The user retains direct supervision and owns permission decisions.

## Main-chat panel

Place a compact **Subagents** panel beneath the conversation toolbar, aligned right.
Use the existing Still typography, near-black surfaces, borders, and radius system;
status color is an accent, never the only status explanation.

```text
┌────────────────────────────────────┐
│ Subagents                 2 active │
│                                    │
│ Codex · Fix session recovery       │
│ Working · Checking reconnect flow  │
│                                    │
│ Claude · Review permission changes │
│ Needs approval                     │
│                                    │
│ OpenCode · Inspect test coverage   │
│ Turn finished              Open ↗  │
└────────────────────────────────────┘
```

- Put the task title first, then the provider/agent identity, status, and latest
  meaningful activity. Do not invent progress percentages or infer status from prose.
- Collapse to **Subagents · N active**, retaining an attention count when needed.
  Show a few rows before scrolling; place finished children in a collapsed section.
- Clicking a row inspects the child without changing the selected parent chat.
  Provide an explicit **Open chat** action to enter the full conversation.
- Offer **Guide**, **Open chat**, and **Stop** in the child's details. Put **Stop all
  subagents** in the parent panel's menu as a separate, explicitly scoped action.
- Reserve room on wide layouts rather than covering messages. On compact windows,
  use an expandable section beneath the toolbar. Coordinate placement with Todos;
  do not stack competing floating boxes over the conversation or composer.
- Hide the empty panel when the parent has no children. Preserve keyboard access,
  visible focus, accessible names, focus return, and reduced-motion behavior.

## Direct access to the child chat

**Open chat must navigate to the same durable child conversation that the parent
spawned, with its real transcript and a working message composer.**

- Reach the child from its parent's panel and the project conversation library.
  Identify it as **Subagent of [parent title]**, show its agent identity and shared
  project folder, and provide **Back to parent** navigation.
- Opening a child is a view change, not a fork, duplicate launch, reset, or implicit
  interruption. The parent keeps running in the background. Returning restores the
  parent's draft, scroll position, and panel state.
- Let the user send messages, answer questions, handle provider permissions, inspect
  tool activity, and stop work using the existing conversation controls.
- Preserve who sent each instruction: **You** versus **Parent agent**. Surface user
  intervention and the resulting child activity to the parent without fabricating
  an acknowledgement that the parent has read it.
- Serialize direct user messages and parent guidance through the same child-owned
  submission path. Do not start concurrent turns or silently overwrite, discard,
  or reorder either source's pending instructions. Keep queued messages inspectable.
- When live steering is supported, reflect its actual acknowledgement. Otherwise,
  queue instructions for the next safe turn boundary. Show **Queued**, **Delivered**,
  or **Failed** honestly; queueing is not an interrupt/restart.
- A finished child can receive a follow-up in the same conversation when the adapter
  supports continuation. Resume its confirmed provider identity when necessary;
  never silently create a replacement session and present it as the original.
- Offline or uncertain child history remains readable and drafts remain editable.
  Submission requires a current, reconciled execution; opening saved history alone
  must not launch a new agent or bypass uncertain-delivery recovery.
- Direct access does not promote the child into a new delegation root or grant it
  additional permissions.

## Parent-agent tool contract

Expose one shared tool, **`still_subagents`**, through the provider-tool
integration paths already used for Todos and conversation titles.

| Action | Intended behavior |
| --- | --- |
| `list` | Return eligible agent choices and the caller's existing children |
| `prepare` | Connect a child without sending its task; return its exact provider configuration options |
| `spawn` | Start a selected agent with a title and bounded task/context; return a stable child ID |
| `inspect` | Read authoritative status, bounded progress/output, pending attention, or the final result |
| `guide` | Submit guidance through the same child queue used by direct user messages |
| `wait` | Wait for a result or attention state with a bounded timeout; do not require rapid polling |
| `cancel` | Request cancellation of the child's active work and report acknowledgement separately |

Spawning is non-blocking so the parent can continue its own work or wait. A result
is associated with the child and its actual turn/execution, not just a mutable title.
Return it to a waiting parent; otherwise retain an unread result in the parent
conversation. Child completion alone must not start an extra paid parent turn.

Pass an explicit task and selected relevant context rather than copying the entire
parent transcript, credentials, or unrelated conversations. Expose model/configuration
choices only when the selected adapter actually offers them.

Provider-native tasks may share this presentation when their lifecycle is observable,
but retain their origin. A native background task is not automatically an inspectable,
resumable child chat. Do not show a functioning **Open chat** action for a provider
task that has no addressable conversation. This limitation does not replace the full
direct-chat requirement for Still-managed children.

### Model-facing delegation guide

**Requested 2026-11-10; shared runtime guide implemented.** The parent AI needs a concise
guide covering actions, fields, provider options, safe sequence, and recovery. Disk
documentation alone is not the model interface.

The canonical guide now lives in the shared `still_subagents` tool and field/action
descriptions used by MCP, Codex dynamic tools, and Pi. Keep it synchronized with the
schema and avoid provider-specific contradictory instructions.

#### Fields the guide must explain

| Field | Meaning and constraints |
| --- | --- |
| `action` | One of the actual action names above; do not invent `send`, `stop`, or other aliases |
| `agentId` | An eligible agent ID returned by `list`; required when preparing a new child or spawning without a prepared child |
| `childId` | The stable child conversation ID returned by `prepare`/`spawn`, not its title, execution ID, or provider session ID |
| `title` | A short task-specific title; required for `spawn`, optional for a new `prepare` |
| `task` | The bounded task and relevant context to submit at `spawn`; preparation alone must not submit it |
| `modelId` | An exact model ID from that child's provider-returned choices, not a guessed display name |
| `effort` | An exact reasoning/effort option for the selected model; available values may change after model selection |
| `modeId` | An exact supported agent-mode ID; Plan/Build must not be inferred from permission profiles or emulated by wording the prompt |
| `message` | Additional child guidance; distinguish queue acknowledgement from actual delivery |
| `timeoutMs` | A bounded wait of 1,000–15,000 milliseconds; a timeout does not mean the task failed |

Include actual schema limits in the runtime descriptions: title 1–160 characters,
task 1–12,000, guidance 1–4,000, model ID 1–300, and effort/mode IDs 1–100.

#### Recommended parent workflow

1. Call `list` and choose an eligible agent for this parent's host/project.
2. Call `prepare` with that agent ID. Retain the returned `childId`; inspect the
   model/effort/mode choices and the current/default selections. Preparation may create
   a provider session, but must not submit a model task.
3. Select a model, refresh its dependent options, and only then select effort/mode.
   Copy provider IDs exactly; omit a setting to retain its effective default. Missing
   controls mean unavailable/unverified, not permission to invent an option.
4. Call `spawn` for that prepared `childId` with a title, task, and validated settings.
   Submit no task until all requested settings have been acknowledged and verified.
5. Use `inspect` to see effective settings, progress/results, pending human requests,
   and queued guidance. Use bounded `wait` instead of rapid repeated polling.
6. Use `guide` for additional instructions. Report **Queued** separately from
   **Delivered**; do not assume that an active child has already read a queued message.
7. Use `cancel` when necessary. Cancellation requested is not confirmed termination;
   inspect the outcome. Queued guidance pauses and existing file edits remain.

#### Remaining preparation refinement — not yet supported

Extend `prepare` to accept an **existing unused `childId` plus requested settings**, as
an alternative to preparing a new agent. This lets the parent choose a model and
receive refreshed effort/mode choices before submitting work, without creating another
child. Scope it to this parent's idle, unused prepared children. Reject unknown,
unrelated, or already-started children rather than launching replacements.

After each acknowledged setting change, reread effective configuration and dependent
choices. Verify the final requested combination before task submission. Do not assume
that changing modes leaves every other setting unchanged.

Option failures should identify the affected prepared child, invalid field, valid
choices, and whether any task was submitted. On uncertain startup or delivery, instruct
the parent to inspect/reconcile before retrying; never repeat the original task blindly.

## Runtime ownership and persistence

Extend the existing persistent supervisors, provider adapters, native store, and
remote journals. Do not add a separate orchestration service, state library, general
event bus, or dependency solely for this feature.

- Persist parent/child conversation IDs, current execution IDs, confirmed provider
  session IDs, agent identity, task/title, shared folder, outcomes, and pending
  operations. A resumed execution must preserve the conversation relationship.
- Keep execution authority remote so closing a chat, switching projects, or losing
  SSH does not terminate already-running children. Closing a view is not cancellation.
- Keep one controlling submission route per child. The current supervisor has a
  single controlling attachment: opening a child in the UI must not take ownership
  away from the parent coordinator, or vice versa. Reuse/proxy the same authority
  for observation, queued messages, permissions, and cancellation.
- Make spawn and message retries idempotent with durable operation identities.
  Reconcile an uncertain acknowledgement before retrying; do not create duplicates.
- Order/deduplicate events by child, execution, and source operation/journal identity.
  Replaying one child's events must not modify another child's transcript or status.
- Restore saved rows as last-known/unknown until remote catch-up confirms current
  state. A missing worker is a recovery condition, not permission to restart a task.
- Keep parent and child turn outcomes separate. A parent can finish responding while
  a child remains active or needs approval; display that remaining work explicitly.
- Reuse shared attention/read-state semantics for the inbox/orb when those surfaces
  are available. Do not double-count a child request and its parent summary, and do
  not make the panel or direct child chat depend on shipping the deferred orb UI.

## Safety and shared-folder behavior

- Scope tools to the authenticated parent's own children and the approved project.
  Never trust model-supplied executable commands, arbitrary child IDs, or folder
  overrides; launch through discovered/configured agent definitions and validated
  arguments. An unrelated conversation cannot control another parent's children.
- Reject Still-managed nested spawn requests server-side and omit delegation tools
  from child contexts. This is a Still orchestration rule, not a claim to sandbox
  provider-native delegation or an otherwise unrestricted shell.
- Apply a small active-child limit. A proposed initial limit is **three per parent**;
  report the limit rather than silently launching or queueing more paid work.
- Make **Shared working folder** explicit. Encourage non-overlapping edit assignments;
  do not promise isolation, conflict prevention, or automatic merging.
- Reuse the shared project Changes view. Do not attribute every working-tree diff
  exclusively to a child when multiple agents or the user can edit those files.
- Stopping a child does not roll back its edits. Stopping the parent's current turn
  does not silently stop children. **Stop all subagents** is a separate explicit
  action; stopping work must also pause its queued follow-ups pending user choice.
- Permission/credential/host-key decisions stay human-owned. The parent cannot approve
  a child's escalation, and delegation must not silently broaden effective access.
- Publish supported, unsupported, and unverified behavior per operation and actual
  adapter/version. An installed executable is not proof of authenticated inference,
  live steering, resumability, or successful cross-agent delegation.

## Implementation sequence

1. **Lifecycle and persistence:** add stable relationships, child lifecycle events,
   idempotent operations, scope validation, and recovery.
2. **Delegation and shared submission:** wire the tool, persistent child launches,
   wait/results, permission routing, cancellation, and serialized user/parent messages.
   Reuse [AG-06](agents-roadmap.md#ag-06-queued-follow-ups-and-steering) queue/steering
   semantics rather than creating a second queue for subagents.
3. **Panel and full child chat:** compact status rows, inspection, direct conversation
   navigation/composer, parent links, queued-guidance state, and responsive behavior are
   implemented; continue polishing accessibility and queue recovery.
4. **Verification:** exercise protocol fixtures and real supported provider pairs;
   document the verified runtime/version and keep untested routes unverified.

Primary integration points, relative to the application root:

- `src-tauri/agent-host/supervisor.mjs`, `bridge.mjs`, and the existing host-tool
  injection paths for remote ownership, provider translation, and delegation.
- `src-tauri/src/agent.rs`, `agent_store.rs`, and `src/bridge/nativeBridge.ts` for
  validated operations, durable native history, and frontend routing.
- `src/agents/types.ts`, `src/agents/workspace.ts`, and `src/session/agentThreads.ts`
  for identity, metadata, reconciliation, and shared conversation state.
- `src/components/AgentWorkspace.tsx`, the existing timeline/composer, one focused
  subagent panel component, and `src/styles/agent-workspace.css` for presentation.
- `tests-agents/` for focused protocol, recovery, and browser coverage.

## Acceptance checklist

- [ ] A new caller-assigned child ID creates local history instead of attempting to
  resume a missing snapshot; verify actual prepare/spawn on the affected Windows build.
- [ ] Resume requires matching saved history/provider identity; missing, conflicting,
  or deleted history cannot silently create a new session or duplicate a prompt.
- [ ] Native tests cover new child creation, valid resume, missing-history rejection,
  identity conflicts, duplicate operations, and preserved parent/scope metadata.
- [ ] All provider tool routes expose the same model-facing action/field guide, exact
  option IDs, defaults, limits, and queue/cancellation/uncertain-delivery semantics.
- [ ] Re-preparing an unused child refreshes model-dependent choices without creating
  another conversation or submitting a task; unrelated/started children are rejected.
- [ ] Invalid/unsupported settings submit no task, return actionable choices and the
  prepared child identity, and never trigger silent model/mode substitution.
- [ ] A real supported parent delegates to a different installed provider in the
  same project folder; its titled child appears in the correct parent's panel.
- [ ] The user opens that exact child chat, sends a message, receives a response,
  and returns to the still-running parent with its draft and position preserved.
- [ ] Parent guidance and direct user messages retain provenance, execute once in
  the correct order, and never create concurrent turns or duplicate child sessions.
- [ ] Guidance is acknowledged as delivered only when dispatched/accepted; unsupported
  live steering queues safely and remains distinguishable from immediate steering.
- [ ] Child approvals/questions can be resolved directly by the user. The parent
  cannot grant approval, and parent summaries do not duplicate actionable requests.
- [ ] Child identity, queued instructions, unread results, and relationships survive
  view closure, disconnect, replay, and app restart without guessing live status.
- [ ] Duplicate/out-of-order events, unknown spawn delivery, and simultaneous UI/tool
  actions do not corrupt another child or produce duplicate work.
- [ ] Nested Still-managed spawning, unrelated-parent control, invalid agent/folder
  inputs, and excess active children are rejected at the runtime boundary.
- [ ] Stops are acknowledged honestly, queued follow-ups pause, file edits remain,
  and parent completion is not mistaken for all-child completion or task correctness.
- [ ] Unavailable agents, failed authentication, unsupported continuation, missing
  workers, and native tasks without a chat have clear, capability-correct states.
- [ ] The panel and full child chat work by keyboard and at compact window sizes,
  with no overlap against Todos, messages, permission forms, or the composer.
- [ ] Live SSH/provider checks and affected packaged-platform checks are recorded
  separately from deterministic fixture coverage before AG-12 is marked DONE.
