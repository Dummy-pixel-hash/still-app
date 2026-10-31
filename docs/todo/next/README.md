# Still Agents — next implementation pack

Date: **2026-10-30** · Repository: `/mnt/data/still/still-app`
Inspected baseline: **`4c3062634438bba368677caa2dcb7b8d3d4fa022`** on `main`.
Progress updated: **2026-11-01**.
Status: **CAP/TD and both deterministic gates complete; GIT-01–04 implementation done. VERIFY-02, VERIFY-03 and VERIFY-04 still need named provider, packaged Windows/WebView2 and authenticated SSH checkout evidence.**

Concurrent project work landed while these specs were being written:
**`a227ac7`** (sidebar rail/Vite host), **`eaaf421`** (compact tool/thought activity),
and **`e25bb3d`** (removal of the custom glass backdrop renderer). `e25bb3d` was the
last observed HEAD, in sync with `origin/main`. Use the then-current agreed HEAD for
implementation; transport/storage inspection here was against `4c30626`. Recheck
status before starting a worker. Current source is the visual implementation
authority where older DESIGN text describes the removed backdrop renderer.

## Start here

This pack turns the next Agents milestones into bounded implementation jobs for a
cost-efficient coding model. Read this page, the assigned task, and its referenced
specification. The old conversation is not required implementation context.

| Document | Purpose |
| --- | --- |
| [TASKS.md](TASKS.md) | Ordered implementation checklist, dependencies, ownership, and completion rules |
| [01-capabilities.md](01-capabilities.md) | AG-11a.1 runtime contract, evidence, freshness, and persistence |
| [02-capability-ui.md](02-capability-ui.md) | AG-11b interaction, exact states, copy, and accessibility |
| [03-todo-reliability.md](03-todo-reliability.md) | AG-18 recovery semantics and remaining correctness work |
| [04-git-review.md](04-git-review.md) | AG-02a read-only remote repository status and diff specification |
| [VERIFICATION.md](VERIFICATION.md) | Acceptance matrix, commands, live-provider procedure, and release evidence |
| [DELEGATION.md](DELEGATION.md) | Small-model handoff prompts, parallelism rules, and escalation criteria |

All source paths in this pack are relative to the repository above. Paths described
as **new** are proposed files, not existing implementation.

## Confirmed baseline

- `b82b469` shipped the model-managed conversation checklist, worker storage, provider
  tool registration paths, native snapshots, and collapsed/expanded Todo UI.
- `4c30626` streams remote bootstrap configuration over SSH stdin. **The user has
  now confirmed that the startup fix works.** Do not repeat that investigation.
- Windows ARM64 run `41069787267` completed successfully:
  <https://github.com/Dummy-pixel-hash/still-app/actions/runs/41069787267>.
  This establishes its build/unit/native-glass checks, not live model tool calls.
- The provider audit in `docs/todo/provider-capabilities.md` established four local
  provider startups. Real model-generated `still_todos` calls are not yet recorded
  per provider/account. Gemini's audited account rejected session creation.
- The accepted UI is the current T3/Codex-informed Agents workspace: existing glass
  materials, provider controls, conversation navigation, and composer-attached Todo
  pill. Todos are agent-authored and read-only in the app.

## Delivery decisions

### Milestone A — trustworthy provider information and Todos

1. Publish runtime/version and narrowly scoped capability evidence.
2. Preserve that evidence through native snapshots and reconnect, with honest
   stale/unknown states.
3. Add a small “Supported by this agent” disclosure.
4. Finish Todo durability/reconciliation checks and fix failures at the shared owner.
5. Record real provider and packaged Windows evidence.

### Milestone B — current repository review

Deliver AG-02a: current Git status and read-only cumulative/staged/unstaged diffs on
the selected SSH host. Reuse the Changes inspector and installed diff renderer.
Git implementation does not depend on resolving Gemini authentication.

The original roadmap remains the long-term backlog. Orb/status migration remains
deferred by the user's direction. Git mutations, worktrees, attachments, queues,
native-provider task synchronization, and general import/export are later milestones.

## Engineering defaults

- Extend existing bridges, event paths, journals, and controls. Add no dependencies.
- Preserve `conversationId`, `executionId`, and provider `agentSessionId` as distinct
  identities. The chosen account/host and canonical project directory own every call.
- Source inspection, fixture success, runtime advertisement, and actual operations
  establish different facts. A displayed capability never authorizes an operation
  by itself; existing native validation and readiness checks remain authoritative.
- Optional metadata must remain backward-compatible with saved history and live
  worker protocol v3. Missing evidence means unverified, not a guessed default.
- A failed optional metadata probe must not destroy a usable conversation.
- Keep new SSH exec arguments bounded. The bootstrap fix is a regression constraint,
  especially if `bridge.mjs` or a bundled source grows.
- Run focused checks during individual tasks; run the milestone gate once after
  integration. Use real-provider prompts only for the named evidence tasks.

## Current working-tree boundary

There is existing uncommitted work. A clean worktree at `4c30626` does **not** include
it. Before implementation, record the current diff and agree which baseline will be
used; do not stash, reset, overwrite, or automatically commit it.

Last observed modified paths (a point-in-time record, not ownership of those edits):

```text
PRODUCT.md
src/bridge/agentMocks.ts
src/components/SessionCard.tsx
src/session/connections.ts
src/styles/theme.css
tests-agents/fixture.html
tests-m5/preview-regressions.mjs
tests-terminal/card-fixture.tsx
tests-terminal/preview.spec.ts
```

Untracked: `src/styles/agent-workspace.css.bak`. Treat it as user work.

## Location and handoff

This pack now lives in [`docs/todo/next/`](README.md) and is linked from the
[master tracker](../README.md). The historical
[provider audit](../provider-capabilities.md) and
[feature roadmap](../agents-roadmap.md) remain the authority for overall feature
status; this pack is the bounded work queue for the next milestones.

SETUP-01 imported the files at HEAD `e25bb3d`. Implementation proceeds task by task
from [TASKS.md](TASKS.md). A worker on another machine or worktree needs the current
branch (or a copy of this directory) before dispatch.

The implementation model has not been selected or launched. Choose it when
delegating; use the exact available model ID rather than inventing an alias.

## Completion rule

A spec being written is not a feature being finished. Close a task only with its
acceptance IDs, relevant check results, and remaining evidence limitations. Keep
provider-specific blockers local to their matrix row. A successful Windows build
does not convert an untested SSH/provider operation into a verified capability.
