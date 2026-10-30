# Agents roadmap and todo

Updated: **2026-10-30**. Status: **AG-11a audit complete; capability work active**.

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

The detailed interpretation of “from the agent window” is in the
[agent-driven orb plan](agent-orb.md): a shared agent-state source, rather than a
publisher whose lifetime depends on the selected conversation being visible.

## Documents

| Document | Purpose |
| --- | --- |
| [Feature implementation plan](agents-roadmap.md) | Scope, tasks, dependencies, code entry points, and acceptance criteria for every feature |
| [Provider capability audit](provider-capabilities.md) | AG-11a results: installed versions, real startup probes, status/todo contracts, and integration gaps |
| [Agent-driven orb](agent-orb.md) | First milestone: signal semantics, background lifecycle, native IPC, conversation routing, and verification |
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
| [AG-12](agents-roadmap.md#ag-12-subagent-visibility) | Child-agent activity, navigation, and outcomes | Later | 5 | AG-01 status identity; AG-11a | TODO |
| [AG-13](agents-roadmap.md#ag-13-integrated-development-tools) | Terminal drawer, file viewer, preview, test results | Later | 5 | AG-02a; AG-04 remote-file access; AG-03 where used | TODO |
| [AG-14](agents-roadmap.md#ag-14-plan-to-implementation-handoff) | Explicit plan → implementation action | Later | 5 | AG-07; AG-11a | TODO |
| [AG-15](agents-roadmap.md#ag-15-portable-history-and-backup) | Restorable export/import and backup | Later | 5 | Existing native history; schemas from features included in export | TODO |
| [AG-16](agents-roadmap.md#ag-16-mobile-access) | Mobile companion access | Later | 6 | AG-01/05; controller/authentication design decision | TODO |
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
7. **Product expansion:** decide AG-16's controller model and AG-17's scheduler
   lifecycle before implementation. These remain later work, with no release date.

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
