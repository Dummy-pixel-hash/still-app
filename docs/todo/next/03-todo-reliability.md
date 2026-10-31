# Specification 03 — finish Todo reliability and release evidence

Roadmap: **AG-18b/e/f/z**, coordinated with **AG-11c**.
Status: the feature exists; this work closes named correctness/evidence gaps.

## Accepted product behavior

- One shared checklist belongs to a durable Still conversation on its selected
  account/host. New provider executions for that conversation reuse it.
- The model is the sole writer through `still_todos`. The app shows task names,
  current-task detail, elapsed duration, and binary Done/Not done state.
- The accepted collapsed pill shows `done/total Todos done` attached above the
  composer. Expansion uses the existing read-only timeline and animation.
- Provider-native plans and task tools are separate. Checking the last Todo is not
  a successful turn, successful tests, permission approval, or an orb signal.

## Existing owner and callers

| Component | Relevant contract |
| --- | --- |
| `agent-host/todos.mjs::createTodoStore` | Atomic file replacement, revision checks, stable IDs, 256 receipts |
| `agent-host/todos.mjs::{requestTodos,markTodoToolReady}` | Authenticated Unix-socket client, timeouts, readiness |
| `agent-host/supervisor.mjs::{todoSnapshot,handle,replay}` | Conversation store and live/replayed Todo events |
| `agent-host/bridge.mjs::CodexDriver.event` | Dynamic tool `item/tool/call`, stable `codex:<callId>` receipt |
| `agent-host/todos.mjs::mcp` | Claude/OpenCode/Gemini MCP route |
| `agent-host/todo-pi.mjs` | Pi scoped extension and `pi:<callId>` receipt |
| `src-tauri/src/agent.rs::{validate_todos,update_todos}` | Native validation and revision reconciliation |
| `src-tauri/src/agent_store.rs::fields` | Durable latest snapshot independent of visible transcript |
| `src/session/agentThreads.ts::{receive,refreshAgentThread,loadAgentThreads}` | Renderer event/snapshot reconciliation |
| `src/components/AgentTodos.tsx` | Read-only view and duration display |

All `agent-host/` paths above are under `src-tauri/`.

## Findings to turn into focused regression cases

These are source-inspection findings, not claims of reproduced user data loss.
Write the smallest deterministic regression first, then fix its shared owner.

1. `createTodoStore.apply` changes its closure `state.activeId` while preparing
   add/focus/complete/remove, before file replacement succeeds. On a pre-rename
   failure the list revision may stay old while active-item memory changes.
2. `update_todos` accepts a different task payload at the **same** revision. Same
   revision availability changes are legitimate; changing task content is not.
3. Renderer `receive` assigns every newer-sequence Todo event directly. A higher
   event sequence is not a higher Todo revision.
4. Worker lock ownership is per execution directory; Todo storage is keyed by
   conversation. Two execution workers could own the same list unless ownership is
   enforced at that second boundary.
5. A missing/recreated remote Todo file can start at revision 0 while native history
   retains a higher revision. Ignoring the old-looking remote snapshot forever would
   show a cached list that no longer matches the provider's actual store.
6. Startup readiness is not the same as a model successfully invoking the tool. Its
   capability evidence is specified in [01-capabilities.md](01-capabilities.md).

## 1. Transactional store changes

Use `state` only as the committed snapshot. Build the entire candidate state in
local variables, validate it, and pass it to the existing `persist` function.

Required behavior:

- On validation failure or a failure before rename, both in-memory `snapshot()` and
  on-disk data remain the previous revision, including active ID, timestamps,
  receipts, ordering, and task details.
- After rename succeeds, the newly committed state remains authoritative in memory
  even if directory fsync or reply delivery fails. Preserve the existing comment
  and this post-rename behavior; rollback would allow an older list to overwrite it.
- A repeated receipt ID with identical input returns the current snapshot without
  a second mutation. Same ID with different input is rejected.
- A retry using a new request ID and stale `expectedRevision` is rejected. The agent
  rereads and reconciles after an uncertain result; a new ID is not exactly-once proof.
- Keep existing item/title/detail/time limits and agent-only mutation checks.

A deterministic pre-rename failure can be tested by temporarily making the store
directory unavailable within the test's private temporary root, checking in-memory
state, restoring the directory, and retrying. Use a minimal test seam only if actual
filesystem error injection cannot exercise the boundary reliably. Do not build a
generic filesystem abstraction solely for one test.

## 2. Revisions and equality

Split comparison into task state and execution availability:

```text
task state = revision + items + activeId
availability = protocolVersion + available + toolAvailable
```

| Incoming same-conversation snapshot | Required result |
| --- | --- |
| Greater revision, valid shape | Accept complete replacement |
| Lower revision during ordinary replay | Ignore task content; it cannot roll back state |
| Equal revision and equal task state | Allow availability changes; avoid emitting identical duplicate UI state |
| Equal revision but different task state | Keep current list; flag conflict; accept resolution only from matching later worker state/catch-up |
| Invalid protocol/item/ID/timestamp/status | Keep readable valid list; report the bounded failure |
| Event from another execution | Reject at attempt/scope boundary before comparison |

The same rule applies at the native boundary and the renderer's defensive merge.
Use a small pure comparison function where it has real callers; keep one validated
native implementation and one typed renderer implementation rather than sprinkling
guards in every component.

For observation/conflict copy, add the following **optional** native/renderer field
to `AgentThreadSnapshot` and `AgentThreadEvent` in TD-03:

```ts
interface AgentTodoSync {
  state: "current" | "stale" | "conflict" | "unavailable"
  reason?: string
}
// Optional containing field: todoSync?: AgentTodoSync
```

Use the existing `todos` event, not a second subscription. Persist this bounded
status in snapshot headers when needed; restore converts current to stale. A missing
field uses existing thread connectivity and Todo service flags for legacy display.
`reason` is native-owned, <=240 characters. This field describes the view's
observation; it does not claim the remote agent stopped working.

On a renderer-only divergent equal revision, schedule at most one existing native
snapshot refresh per `(executionId, revision)`. Native `agentSnapshot` reads current
native state; it does not query the provider/remote store. A native conflict stays
`todoSync.state = "conflict"` until a later valid worker event or reconnect catch-up
establishes consistent state. Avoid a self-triggering refresh/notice loop and do
not add an app Todo mutation or new provider endpoint to force reconciliation.

## 3. Store recovery and execution ownership

### Ownership

At worker creation, acquire exclusive ownership for the conversation Todo directory
as well as the existing per-execution worker lock. A small exclusive lock containing
the owning execution ID and worker PID is enough for the current Linux-host contract.

- If that owner is live, reject a second worker for the same conversation before
  opening or rewriting the Todo file. Existing attach goes to the original worker.
- Use an exclusive create and verify the stored owner; never remove another live
  worker's lock during cleanup.
- Existing/ambiguous/stale locks are a bounded, inspectable error in this slice.
  Do not implement a racy check-PID-then-unlink recovery: two recovering workers
  could delete each other's lock. Confirmed stale-owner cleanup is an explicit
  recovery action; automated stale-lock reaping is not part of this task.
- A clean worker shutdown releases its own lock. Confirmed provider-child exit
  first retires all mutation handling, then releases that worker's owned lock, so a
  normal new execution can resume. Early startup errors must also release ownership
  acquired by that worker. Install cleanup before the first fallible store operation.
- Legacy v3 workers do not acquire this new lock. Use the existing native
  attach/close/resume checks to avoid replacing a known live legacy execution; do not
  claim the new lock can constrain an already-running unmodified old worker on a
  different device. Test two upgraded workers and this legacy boundary separately.

### Missing remote store on a new execution

Pass the last **validated task state** as optional `todoSeed` in the existing
stdin bootstrap payload for a resumed conversation. Read the seed at the supervisor
owner; never trust a renderer-supplied replacement list.

The outer SSH stdin fix is not sufficient by itself: `bootstrap.mjs` still base64-
encodes the remaining config into the transport argv, which is then used to spawn
the worker. A maximum-sized Todo seed can exceed Linux's per-argument limit there.
Write the seed to a fixed **`todo-seed.json`** file under the newly owned private
execution directory (0600, exclusive create), remove it from the encoded config,
and carry only a boolean `hasTodoSeed`. The worker resolves that fixed basename,
checks ownership/regular-file/no-symlink/1-MiB size, and validates its contents.
No arbitrary seed path is accepted. Test a near-limit title/detail list and assert
both transport and worker arguments remain bounded. Preserve failed seed evidence
for inspection; it is not permission to replace a conflicting remote store.

- Existing valid remote store wins. The seed is used only for **ENOENT**, not for
  malformed files, wrong ownership, symlinks, or permission errors.
- If the seed is newer than an existing remote file, fail with a specific
  reconciliation-required explanation. Do not silently overwrite either history.
- If remote and seed revisions are equal but task contents disagree, fail with the
  same explanation. If remote is newer, use it and catch up normally.
- Seed carries `revision`, `items`, and `activeId`; readiness, capability evidence,
  and execution identity are recomputed for the new worker.
- New conversation without a seed starts empty at revision 0. Worker files and seed
  payload remain private to the selected host/account.

At `_still/caught_up`, a lower authoritative remote revision than the saved native
list is a conflict, not an endlessly ignored replay event. Keep the cached list
visible and surface **“Showing saved Todos; the remote list does not match.”** with
`todoSync.state = "conflict"`. Refresh may confirm convergence; persistent conflict
requires inspecting both saved and remote state, not silently resetting either.
Do not claim tool execution was paused or that a new attempt fixes an existing
conflicting file. Ordinary lower-revision replay events before catch-up remain
harmless.

## 4. Persistence, history, and availability

| Operation | Fixed semantics |
| --- | --- |
| WebView reload / app restart offline | Latest valid saved list remains readable, including active detail/durations |
| SSH disconnect | Keep list; observation becomes stale; provider may continue updating remotely |
| Reattach original worker | Catch-up replaces with authoritative newer state once; no replay mutation |
| Provider resume/new execution, same conversation | Reuse remote conversation list; use validated seed only if remote file is absent |
| Revert / Retry | Rewind provider messages only; **keep current shared Todo list**. The model rereads/reconciles it |
| Pi internal provider fork during Revert | Still conversation identity is unchanged, so the same shared list remains |
| Delete from local library | Existing local deletion semantics apply; no speculative remote Todo cleanup |
| Different conversation or host | Never share IDs/store automatically |
| General fork/import/export | Future AG-10/15 work; record the boundary rather than implementing it here |
| Existing `/copy` | Still copies conversation text as Markdown; it is not a restorable Todo backup |

Preserve latest task state in native snapshot headers even when history truncates
the Todo event that originally introduced it. Test checkpoint compaction after
Revert and a subsequent provider resume. Ordinary conversation activity ordering
must not be affected by metadata-only or readiness-only Todo notifications.

Legacy behavior:

- Worker protocols before v3 cannot receive Todo calls; show saved tasks read-only.
- Missing optional capability metadata on a v3 worker does not invalidate its
  already-supported Todo store or force a restart just to view history.
- `available` describes the worker Todo service contract; `toolAvailable` describes
  provider registration. Offline observation is a separate state. Never label every
  unavailable snapshot “older execution” when the cause is a conflict/disconnect.

Keep the existing service flags truthful. Use `todoSync` for stale/conflict display
rather than changing service availability to simulate an offline or paused agent.

The expanded panel may show a small contextual status line for stale/unavailable
data using existing style. Keep completed durations fixed; describe ongoing elapsed
time as a duration since start, not verified continuously active computation.

## 5. Real provider calls and release evidence

Use one tiny disposable conversation per active installed provider/model on the
selected host. Ask the actual model to list, add two named tasks, focus one with a
short detail, mark one complete, and list again. Check the native list, tool response,
and read-only UI refer to the same IDs/revisions.

Then use one representative available provider for native restart/disconnect/resume
tests. There is no need to repeat every filesystem failure case through paid model
inference; deterministic worker/native tests cover them.

Codex, Claude, Pi, and OpenCode each need their own generated-call record. Gemini is
blocked until usable runtime access is supplied. A blocked provider row is not a
reason to repeatedly run the whole matrix. The startup success the user just
reported closes the startup regression, not these generated-call checks.

Exact prompt, metadata to record, and test commands: [VERIFICATION.md](VERIFICATION.md).

## Acceptance IDs

| ID | Observable result |
| --- | --- |
| TODO-AC1 | Pre-rename failure leaves committed task state/receipts unchanged; post-rename uncertainty retains the committed state |
| TODO-AC2 | ACK loss and same-ID retry cannot duplicate a mutation; stale new-ID retry cannot overwrite newer work |
| TODO-AC3 | Equal revision can change availability but never task contents; lower replay revisions cannot roll back |
| TODO-AC4 | Two upgraded same-conversation workers cannot both mutate the shared store; legacy ownership limits remain explicit |
| TODO-AC5 | Valid missing-store seed restores the last list; corruption/conflicting stores stay inspectable |
| TODO-AC6 | Native restart, checkpoint, Revert/Retry, Pi internal fork, and resume retain the current list |
| TODO-AC7 | Offline/legacy/conflict views are honest, read-only, and keep the accepted pill behavior |
| TODO-AC8 | A complete checklist changes no turn result, tests outcome, approvals, or orb signal |
| TODO-AC9 | Named live model tool calls and packaged Windows lifecycle checks have recorded evidence or specific blockers |
