# Agents roadmap and todo

Updated: **2026-11-09**. Status: **AG-11a audit complete; capability and Todo
follow-ups scheduled; next-milestone execution pack imported**.

**AG-12 update (2026-11-09):** the parent-agent tool path and direct child-chat flow are
under implementation in [Subagent integration and direct chat](agent-subagents.md).
Fixture coverage is being added; real provider, reconnect, and crash-recovery validation
remain before the feature can be marked complete.

**AG-16 Android planning update (2026-11-09):** the thread-first phone direction,
desktop-to-phone remote continuity, background-alert requirement, architecture gates,
implementation tasks, and acceptance matrix are saved in
[Android phone application](android-mobile.md). This replaces the earlier assumption
that mobile must depend on a running desktop. Production implementation is started
at the MOB-01 Android compile-spike only; phone runtime and the rest remain TODO.
Relay deployment and delivery-order changes are not implicitly approved.
The [full Android implementation todo list](android-mobile-tasks.md) expands every
mobile milestone into checkable work and release-evidence items.

The remote agent startup regression is resolved. Commit `4c30626` streams the
bootstrap configuration over SSH stdin, and the user confirmed the fix works
against a real server. That confirmation covers startup only; provider-generated
Todo calls and the wider capability matrix still need their own evidence.

This is the implementation tracker for the Agents feature-gap review. The goal is
to complete the **request → supervise → review → ship** workflow around Still's
existing remote-agent execution and local conversation library.

## Agreed direction

- **Current focus:** provider-capability audit and Agents/todo foundations. The user
  has deferred orb work for now; its documented design remains a later milestone.
- The **existing smoked-glass orb becomes the Agents workspace's status companion**.
  Its facts come from the same structured conversation state as the Agents window.
  SSH-terminal activity stops being its signal source when AG-01 ships.
- The orb represents managed agent conversations, including background work.
  Clicking a conversation opens it in **Agents**, with its pending request or result.
- Add **agent-managed conversation Todos**: model-authored task names, a current
  task and optional progress detail, durations, and binary Done/Not done progress.
  Still displays these read-only. See [AG-18](agents-roadmap.md#ag-18-conversation-todos-and-task-progress).
- Closing the Agents surface or minimizing Still must preserve observation of
  already-running agents. The native companion continues to use the main app as its
  publisher; it does not become an independent agent client.
- The existing project/conversation layout, remote execution, offline history,
  provider-aware controls, and smoked-glass appearance are the foundation.
- **Subagents:** any eligible installed/configured agent can delegate to another on
  the same host/project, one level deep, in the shared folder. A compact parent-chat
  panel shows child titles and status, and the user can open and message each
  Still-managed child directly. See the [AG-12 specification](agent-subagents.md).

The detailed interpretation of “from the agent window” is in the
[agent-driven orb plan](agent-orb.md): a shared agent-state source, rather than a
publisher whose lifetime depends on the selected conversation being visible.

## Documents

| Document | Purpose |
| --- | --- |
| [Next milestone execution pack](next/README.md) | Bounded AG-11a.1/AG-11b/AG-18/AG-02a specs, ordered tasks, verification matrix, and delegation handoffs |
| [Feature implementation plan](agents-roadmap.md) | Scope, tasks, dependencies, code entry points, and acceptance criteria for every feature |
| [Provider capability audit](provider-capabilities.md) | AG-11a results: installed versions, real startup probes, status/todo contracts, and integration gaps |
| [Agent-driven orb](agent-orb.md) | First milestone: signal semantics, background lifecycle, native IPC, conversation routing, and verification |
| [Subagent integration and direct chat](agent-subagents.md) | Approved AG-12 plan: cross-agent delegation, compact parent panel, direct child conversations, shared-folder safety, and verification |
| [Android phone application](android-mobile.md) | AG-16 Android-first APK plan: reviewed mobile UX, shared remote history/control, background push, native integration, tasks and release evidence |
| [Full Android implementation todo list](android-mobile-tasks.md) | Checkable MOB-01–15 work breakdown, decision gates, dependencies, release acceptance and evidence records |
| [Current agent behavior](../agents-ui-and-persistence.md) | Existing controls, remote persistence, and current limitations |
| [Current orb behavior](../../ORB.md) | Existing companion behavior and platform verification |
| [Earlier T3 review](../agents-t3-review.md) | Historical design and implementation record |

## Existing foundation

These capabilities are already implemented to varying, provider-dependent extents.
They are inputs to the roadmap, rather than new todo items.

| Area | Existing implementation |
| --- | --- |
| Conversation library | Explicit server/folder projects, local history, drafts, search, pinning, renaming, and archiving |
| Remote execution | Detached server-side workers, replay journals, prompt receipts, and reattachment |
| Providers | OpenCode, Codex, Claude Code, Pi, and Gemini integrations |
| Conversation controls | Model/reasoning settings, provider-exposed modes and commands, approvals, and questions |
| Inspection | Markdown/code rendering, tool output, plans, and provider-reported patches |
| History actions | Capability-gated conversation Revert/Retry; project files are kept |
| Companion | Opt-in native orb, bounded metadata transport, accessibility, motion settings, and placement |

Evidence: source inspection and synthetic browser checks from the feature-gap
review. This is not a claim that all provider versions or packaged Windows flows
have been exercised. The per-feature acceptance criteria below require that evidence.

## Master tracker

Status values: **TODO**, **IN PROGRESS**, **BLOCKED**, **DONE**, **DEFERRED**.
Priority describes product sequencing, not defect severity. All new work starts TODO.

| ID | Feature | Priority | Phase | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |
| [AG-01](agent-orb.md) | Agent-driven orb and conversation activation | High | 1 | AG-11a capability inventory; user deferred orb work | DEFERRED |
| [AG-02](agents-roadmap.md#ag-02-live-git-review-and-delivery) | Live Git status/diffs, review feedback, commit/push/PR | High | 2 | Existing authenticated project connection | TODO |
| [AG-03](agents-roadmap.md#ag-03-remote-worktree-isolation) | Remote worktrees, setup, handoff, and cleanup | High | 2 | AG-02a repository identity/status | TODO |
| [AG-04](agents-roadmap.md#ag-04-attachments-and-file-context) | Screenshots, files, and remote file/line references | High | 3 | AG-11a | TODO |
| [AG-05](agents-roadmap.md#ag-05-agent-inbox-and-notifications) | Agent inbox, unread results, optional notifications | High | 1 | AG-01 shared status/read-state foundation | TODO |
| [AG-06](agents-roadmap.md#ag-06-queued-follow-ups-and-steering) | Durable follow-up queue and supported live steering | Medium | 3 | AG-04a message-parts contract; AG-11a | TODO |
| [AG-07](agents-roadmap.md#ag-07-execution-policy-controls) | Effective sandbox, permission, and network controls | Medium | 3 | AG-11a | TODO |
| [AG-08](agents-roadmap.md#ag-08-usage-and-context-visibility) | Context/token usage, limits, and reported cost | Medium | 4 | AG-11a | TODO |
| [AG-09](agents-roadmap.md#ag-09-file-checkpoints-and-rollback) | File checkpoints and guarded restoration | Medium | 4 | AG-02a; AG-03 | TODO |
| [AG-10](agents-roadmap.md#ag-10-session-import-and-conversation-forks) | Existing provider-session discovery and forks | Medium | 4 | AG-11a; AG-03 for isolated file forks | TODO |
| [AG-11](agents-roadmap.md#ag-11-provider-capability-clarity) | Runtime capability inventory and explanatory UI | High foundation | 0, then ongoing | AG-11a audit complete; live publication, UI, and evidence follow-ups remain | IN PROGRESS |
| [AG-12](agents-roadmap.md#ag-12-subagent-integration) | Cross-agent delegation, direct child chats, and supervision | Later | 5 | Shared conversation status; AG-11 capabilities; AG-06 queue/steer contract | TODO |
| [AG-13](agents-roadmap.md#ag-13-integrated-development-tools) | Terminal drawer, file viewer, preview, test results | Later | 5 | AG-02a; AG-04 remote-file access; AG-03 where used | TODO |
| [AG-14](agents-roadmap.md#ag-14-plan-to-implementation-handoff) | Explicit plan → implementation action | Later | 5 | AG-07; AG-11a | TODO |
| [AG-15](agents-roadmap.md#ag-15-portable-history-and-backup) | Restorable export/import and backup | Later | 5 | Existing native history; schemas from features included in export | TODO |
| [AG-16](agents-roadmap.md#ag-16-mobile-access) | Android phone app, remote continuity and alerts | Later | 6 | Shared AG-01/05 state contracts, not orb UI; architecture gates in the Android plan | TODO |
| [AG-17](agents-roadmap.md#ag-17-scheduled-agent-tasks) | Explicitly scheduled remote tasks | Later | 6 | AG-01/03/05/06/07; server scheduler design decision | TODO |
| [AG-18](agents-roadmap.md#ag-18-conversation-todos-and-task-progress) | Agent-managed Todos with read-only progress in Still | High | 1 | AG-11a task capability inventory; existing native history | IN PROGRESS |

Suffixes such as **AG-02a** refer to individual checklist tasks in the feature plan.
AG-11a is deliberately small: identify the actual capabilities needed by the next
feature, using the current integrations. The whole capability-settings UI is not a
prerequisite for the orb.

## Delivery order

**Active override:** start with AG-11a and its capability follow-ups, then AG-18 todo
foundations. AG-01 and orb-dependent sequencing below are deferred until the user
resumes that work. The original phase grouping remains for long-term planning.

The concrete order, owned files, and acceptance IDs for the next two milestones are
in the [execution pack](next/TASKS.md): capability publication and its explanatory
UI (`CAP-*`, `UI-01`), Todo reliability (`TD-*`), then read-only Git review
(`GIT-*`). Feature status here stays authoritative; a task checkbox in the pack is
not a completion record on its own.

1. **Foundation:** AG-11a inventories real provider support. AG-01a preserves typed
   turn outcomes and stable event identities needed for truthful statuses.
2. **Agent supervision:** finish AG-01, then AG-05. Add AG-18 conversation todos
   alongside this phase once its provider capabilities are verified; it does not
   block the initial orb. Ship agent-driven status, conversation deep links, task
   progress, and a shared inbox before adding more workspace tools.
3. **Review and isolation:** AG-02a read-only repository review → AG-03 worktrees →
   AG-02b/c delivery and review-feedback actions. A useful read-only diff can ship
   before the complete Git workflow.
4. **Daily interaction:** AG-04 attachments/context, AG-06 queue/steering, and AG-07
   effective policy controls. Expand AG-11's UI alongside the capabilities exposed.
5. **Recovery and visibility:** AG-08 usage, AG-09 file checkpoints, AG-10 import/forks.
6. **Workspace depth:** AG-12 subagents, AG-13 development tools, AG-14 plan handoff,
   and AG-15 portable history. These can be scheduled independently once their
   listed dependencies are available.
7. **Product expansion:** follow the [Android plan](android-mobile.md) for AG-16's
   desktop-independent remote-client goal, controller/history contract and push
   deployment gates. Decide AG-17's scheduler lifecycle separately. These remain
   later implementation work, with no release date; the planning update alone does
   not override the active order above.

The phase numbers in the tracker are stable group names: 0 foundation, 1 supervision,
2 Git/worktrees, 3 interaction, 4 recovery/visibility, 5 workspace depth, 6 expansion.

## How to maintain this tracker

- Keep feature status in the master table and implementation checkboxes in the
  linked feature document. Record an actual blocker when marking BLOCKED.
- Mark DONE only after the feature's acceptance criteria are met. Add the relevant
  commit/reference, checks run, provider/runtime versions, and native verification
  when applicable beside the completed feature.
- Keep supported, unsupported, and unverified provider behavior distinct.
- Update current-behavior documentation when a feature ships. Until then, its
  specification describes a target, not a runtime guarantee.
- Reuse the existing bridge, native store, worker, and UI primitives. Add narrowly
  scoped fields/functions as needed; these plans do not require a new state library,
  general event bus, or dependency.

## Comparison references

The comparison inspected T3 Code source at
[`08a463e29976617134de01e9341f898bc881d0eb`](https://github.com/pingdotgg/t3code/tree/08a463e29976617134de01e9341f898bc881d0eb),
including Git actions, attachments, queued runs, notifications, context/usage,
subagents, and checkpoint/fork services. These are feature references; runtime API
support must be verified against the provider actually installed on the user's host.

- [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex mobile](https://learn.chatgpt.com/docs/mobile)
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations)

Portable backups and the specific orb integration are Still product requirements,
not claims that every comparison app implements an identical feature.
