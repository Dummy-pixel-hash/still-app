# Implementation checklist

All implementation tasks start **TODO**. This file is the execution checklist;
writing the specifications does not complete these tasks. The current conversation's
Todo panel tracks production of this planning pack separately.

Repository: `/mnt/data/still/still-app`. Read [README.md](README.md) for the baseline
and existing working-tree changes. No task below requires the original transcript.

## Ordered queue

- [x] **SETUP-01** — Adopt the baseline and import this pack into project docs. **Done 2026-10-30** at `e25bb3d`; see [VERIFICATION.md](VERIFICATION.md#completed-evidence). **S**.
- [x] **CAP-01** — Shared capability/runtime types. **Done 2026-10-30**; `npm run typecheck` passed. **S**.
- [x] **CAP-02** — Selected-executable version discovery. **Done 2026-10-30**; `cargo test --lib agent::tests::`, `node --test protocol/bootstrap/supervisor` and `npm run typecheck` passed. **M**.
- [x] **TD-01** — Transactional Todo mutations and receipt failure tests. **Done 2026-10-30**; new `tests-agents/todos-store.test.mjs` proven failing-before/passing-after. **S**.
- [x] **CAP-03** — Worker-owned capability reports and truthful tool evidence. **Done 2026-10-30**; supervisor suites + `cargo test --lib --bins` + typecheck pass, with observed/advertised distinction covered. **M**.
- [x] **CAP-04** — Native validation, freshness, and durable report snapshots. **Done 2026-10-31**; native validation/freshness/store tests and full Rust lib/bin gate pass. **M**.
- [x] **CAP-05** — Renderer report reconciliation and scoped discovery cache. **Done 2026-10-31**; focused capabilities/workspace Playwright 61 passed, typecheck/build pass. **M**.
- [ ] **UI-01** — Agent details disclosure and settings metadata. Browser implementation is done; awaiting the required packaged WebView2 interaction evidence before closure. **S–M**.
- [x] **TD-02** — Conversation store ownership and missing-store seed. **Done 2026-10-31**; 40 worker/protocol/bootstrap/store tests and 61 Rust tests pass (2 ignored). **M**.
- [x] **TD-03** — Todo revision/history/native lifecycle reconciliation. **Done 2026-10-31**; native task-state/availability/conflict/history tests and 68 capability/Todo/workspace Playwright tests pass. **M**.
- [x] **VERIFY-01** — Milestone A deterministic integration gate. **Done 2026-10-31**; `npm run test:agents` passed (60 Node, 118 Playwright), Rust lib/bin tests passed (67, 2 ignored), and typecheck/build passed. UI-01's packaged WebView2 and live-provider evidence remain separate gates. **S**.
- [ ] **VERIFY-02** — Real provider-generated Todo calls and evidence matrix. After VERIFY-01; needs named host/models. **S per provider**.
- [ ] **VERIFY-03** — Packaged Windows lifecycle and Milestone A release record. After VERIFY-01; needs a test build. **S**.
- [x] **GIT-01** — Git types and pure status/numstat parsers. **Done 2026-11-01**; 8 parser tests and the registered 68-test Node suite pass; `npm run typecheck` passes. **S–M**.
- [x] **GIT-02** — Bounded read-only Git helper. **Done 2026-11-01**; 16 Git parser/helper tests and the registered 76-test Node suite pass; `npm run typecheck` passes. **M**.
- [x] **GIT-03** — Native Git IPC and scoped snapshot registry. **Implementation done 2026-11-01**; 6 native boundary tests, full Rust and build/type gates pass. The real SSH fixture remains pending under VERIFY-04/V-GIT-REMOTE. **M**.
- [x] **GIT-04** — Repository inspector and scoped refresh lifecycle. **Implementation done 2026-11-01**; 7 Git UI tests and the full 125-test Playwright suite pass; view separation, refresh/race scopes, states and accessibility are covered. **M**.
- [ ] **VERIFY-04** — Git end-to-end/read-only/native gate and docs. Deterministic B gate passed **2026-11-01**; live SSH checkout and packaged Windows/WebView2 evidence remain pending. **S**.

### Reported Git runtime regression — 2026-11-01

- [x] **FIX-GIT-EOF** — Fix the reported “Remote Git helper did not exit successfully” error. Native must keep reading after SSH output EOF until channel close and validate the later exit status. An authenticated in-memory SSH regression reproduced the original error and now passes; missing/nonzero exit, signal termination and stalled close still fail. Also corrected native `headOid` field serialization. **Implementation verified; packaged rebuild and user retest pending.**
- [ ] **VERIFY-GIT-EOF-PACKAGED** — Rebuild Windows ARM64 with FIX-GIT-EOF, then retry Repository/Refresh on the user's selected `Darsh@100.86.95.34` project `/mnt/data/git-test`. Confirm status and diff loads from the native app; this remains part of VERIFY-04, not inferred from fixture tests.

## User inputs needed to close external evidence

1. **V-GIT-REMOTE / VERIFY-04:** Connect the desired SSH host in Still and identify an
   exact project folder containing a **disposable Git repository**. The remote host
   needs Git and Node 20+. Do not send credentials or private keys; authenticate in
   Still. Fixture setup may create test commits/files in the disposable repo, but the
   review reads themselves must leave HEAD, index, and file contents unchanged.
2. **VERIFY-03 / UI-01:** Run an integrated packaged build on Windows x64 or ARM64 and
   report its build SHA, Windows version, and WebView2 runtime. Exercise keyboard
   open/close/focus-return, Repository/Conversation switching, refresh, and offline
   reattach. This plan is not authorization to publish or dispatch a workflow.
3. **VERIFY-02:** Select a target host/project plus provider and model for the live
   Todo prompt. Gemini remains blocked by the previously audited account; an available
   non-Gemini provider is the quickest route. Keep secrets out of the evidence.

Sizes are relative context/change size, not price or elapsed-time promises. Exact
provider cost depends on the selected available model and billing configuration.

## Scheduling

Default: **one budget builder**, one bounded task at a time. Use a second builder
only where file ownership is genuinely disjoint. A stronger reviewer checks the
integrated boundary-sensitive changes once, with evidence supplied by the builder.

```text
SETUP-01
  ├─ CAP-01 → CAP-02 ─┐
  └─ TD-01 ───────────┴→ CAP-03 → CAP-04 ─┬→ CAP-05 → UI-01 browser ─┐
                                           └→ TD-02 ─────────────────┴→ TD-03 → VERIFY-01 deterministic
                                                                               ├→ VERIFY-02 live-provider evidence
                                                                               └→ VERIFY-03 packaged Windows (also closes UI-01)

Milestone B after VERIFY-01: GIT-01 ✓ → GIT-02 ✓ → GIT-03 ✓ → GIT-04 ✓ → VERIFY-04
```

- CAP-02 and TD-01 can run in parallel on separate branches after CAP-01 because
  their owned implementation files differ.
- After CAP-04, CAP-05/UI-01 and TD-02 can run independently. TD-03 starts after both
  branches land; it shares the renderer/fixture with that UI stream.
- VERIFY-02 and VERIFY-03 can use independent host/build environments. If they use
  the same conversation or packaged app, run them sequentially.
- Default start for Milestone B is after reviewing Milestone A. A Gemini account
  blocker does not block GIT-01. A spare agent may build the pure Git parser earlier
  if the coordinator explicitly assigns that independent work.
- Shared types, `agent.rs`, `bridge.mjs`, `supervisor.mjs`, `AgentWorkspace.tsx`,
  shared CSS, and `tests-agents/fixture.tsx` each have **one writer at a time**.

## Task packets

### SETUP-01 — baseline and documentation

**Read:** this pack's README and `docs/todo/README.md`.

**Work:** inspect current HEAD/status; account for concurrent commits through
`e25bb3d` noted in README and remaining user edits. Import the eight files in this pack into
`docs/todo/next/`; add a link from the existing tracker. Record user-confirmed startup
success. Reconcile the old PRODUCT Todo-summary wording only if assigned ownership
of that already-modified file. Preserve the old provider audit as dated evidence.

**Own:** new `docs/todo/next/` files and a narrow edit to `docs/todo/README.md`.
**Done:** documentation links resolve; baseline and commit policy are recorded.
No source implementation or provider probing belongs in this task.

### CAP-01 — shared contract

**Read:** specification 01, Contract and Native validation sections.
**Own:** `src/agents/types.ts`.

Add the named types and optional event/snapshot/availability fields. Retain all
existing public fields and legacy snapshot compatibility. Export only types needed
by real planned callers. Document the worker wire shape without `freshness`.

**Checks:** V-TYPE. **Acceptance:** compile-time foundation for CAP-AC1/5/6/7.
**Handoff:** exact type names/fields and any existing fixture constructors that
need attention later. Do not add runtime support defaults in this type-only task.

### CAP-02 — runtime discovery

**Read:** specification 01, Runtime identity and Discovery cache identity.
**Own:** `src-tauri/src/agent.rs` detection/start helpers;
`src-tauri/agent-host/bridge.mjs` runtime version metadata only; focused native tests.

Implement a shared bounded probe for discovery and fresh selected-provider starts.
Carry selected runtime metadata through the existing bootstrap. Reuse OpenCode's
actual server version. Keep ordinary detection/launch useful if version lookup
fails. Avoid source growth that exceeds per-argument limits in catalog/start paths.

**Checks:** V-RUST-AGENT, V-BOOT, V-PROTOCOL for changed startup metadata.
**Acceptance:** CAP-AC1; native side of CAP-AC2.
**Handoff:** wire runtime field, timeout/byte limits, executable-override cases.

### TD-01 — committed-state correctness

**Read:** specification 03, Transactional store changes and receipt semantics.
**Own:** `src-tauri/agent-host/todos.mjs::createTodoStore`; new focused
`tests-agents/todos-store.test.mjs`.

Reproduce pre-rename active-state mutation and fix candidate-state construction.
Cover identical receipt retry, conflicting receipt input, stale revision, and the
post-rename acknowledgement-loss boundary. Keep MCP/readiness code out of this
task's diff so CAP-03 can land cleanly after it.

**Checks:** V-TODO-STORE, V-WORKER. **Acceptance:** TODO-AC1/2.
**Handoff:** failing-before/passing-after case and exact durability guarantees.

### CAP-03 — worker facts and readiness

**Read:** specification 01, Initial feature states and Worker publication.
**Own:** `src-tauri/agent-host/{bridge,supervisor,todos,todo-pi}.mjs` capability,
registration, and generation paths; `tests-agents/{protocol,supervisor}.test.mjs`
and `protocol-peer.mjs` where needed.

Build the report from acknowledged runtime facts. Add optional report to session
metadata/catch-up and journal its semantic changes. Distinguish registration from
observed operations. Fix false Codex resume readiness and OpenCode config-write
inference. Test provider-session/config generation changes and legacy metadata.

**Checks:** V-PROTOCOL, V-WORKER, V-BOOT.
**Acceptance:** CAP-AC3/4/9; worker side of CAP-AC5/7/8.
**Handoff:** representative wire JSON plus observed-vs-advertised fixture evidence.

### CAP-04 — native observer and history

**Read:** specification 01, Native validation and freshness; current
`agent.rs::{handle,update,transport_lost,still_agent_attach}` and `agent_store::fields`.
**Own:** `src-tauri/src/{agent,agent_store}.rs`.

Validate optional reports, match actual scope, manage stale/current transitions,
persist report headers/events, and retain Gemini's explicit load-session fact.
Retain old history and live-v3 compatibility. Invalid optional metadata produces a
bounded notice rather than terminating a turn. Keep capability events out of
conversation activity accounting.

**Checks:** V-RUST-AGENT, V-RUST-STORE.
**Acceptance:** CAP-AC5/6/7/8/9 at native boundary.
**Handoff:** validation failures, restore/catch-up ordering, journal proof.

### CAP-05 — renderer scope and stale state

**Read:** specification 01, Discovery cache identity and lifecycle table.
**Own:** `src/session/{agentDiscovery,agentThreads}.ts`,
`src/agents/capabilities.ts` (new if useful), discovery callers in
`src/components/AgentWorkspace.tsx`, focused `tests-agents/capabilities.spec.ts`
and shared fixture additions.

Store metadata without transcript noise, reject old-attempt/generation results,
invalidate restored observations, and key discovery requests to selection and
connection. Both automatic discovery and the manual Refresh caller must use the
same rule. A late response cannot restore an obsolete executable selection.

**Checks:** V-TYPE, V-CAP-UI (state/race subset).
**Acceptance:** CAP-AC2/5/6/7/9 at renderer boundary.
**Handoff:** selector/fixture API and scoped refresh callback for UI-01.

### UI-01 — explanatory interface

**Read:** specification 02, current `DESIGN.md`, `AgentControls.tsx`, and
`useAgentPopover.ts`.
**Own:** new `src/components/AgentCapabilities.tsx`, narrow `AgentWorkspace.tsx` and
existing CSS changes, `tests-agents/capabilities.spec.ts`, shared fixture additions.

Build the specified disclosure and settings installation metadata using existing
visual/focus patterns. Cover all named states and readable long values. The report
is explanatory; existing action guards remain the operation authority.

**Checks:** V-TYPE, V-CAP-UI, existing accessibility/model/Todo interaction tests.
**Acceptance:** UI-AC1–6.
**Handoff:** desktop/compact captures, focus tests, and any native evidence still due.

### TD-02 — one store owner and recoverable seed

**Read:** specification 03, Store recovery and execution ownership; bootstrap code.
**Own:** Todo ownership/seed paths in `src-tauri/agent-host/{supervisor,todos,bootstrap}.mjs`,
seed creation in `src-tauri/src/agent.rs`, focused worker/bootstrap tests.

Prevent new compatible workers from writing the same conversation store. Exercise
ownership conflicts/cleanup. Carry native validated seed through stdin and a bounded
private bootstrap file, not a growing process argument. Use it only for a missing
store and preserve conflicting/corrupt originals.

**Checks:** V-TODO-STORE, V-WORKER, V-BOOT, V-RUST-AGENT.
**Acceptance:** TODO-AC4/5.
**Handoff:** owner recovery semantics, old-worker boundary, oversized-seed test.

### TD-03 — revision and history reconciliation

**Read:** specification 03, Revisions/equality and Persistence/history tables.
**Own:** Todo paths in `src-tauri/src/{agent,agent_store}.rs`,
`src/session/agentThreads.ts`, `src/agents/types.ts` for optional `todoSync`, optional
pure `src/agents/todos.ts`, contextual status in `AgentTodos.tsx` and its
`AgentWorkspace.tsx` caller, and new `tests-agents/todos.spec.ts` plus native tests.

Enforce task equality at the same revision while permitting availability updates.
Distinguish old replay from an authoritative catch-up conflict. Preserve current
Todos through Revert/Retry, journal compaction, provider-session changes, and native
restore. Add only the minimal conflict/stale status plumbing specified in 03.

**Checks:** V-RUST-AGENT, V-RUST-STORE, V-TODO-UI, V-TYPE.
**Acceptance:** TODO-AC3/6/7/8.
**Handoff:** failure-state UI, native persistence proof, and exact unresolved cases.

### VERIFY-01 — Milestone A deterministic gate

**Read:** verification matrix. **Own:** `package.json` test-script registration,
integration fixes in assigned files only;
`docs/todo/next/VERIFICATION.md` evidence entries.

Integrate CAP/UI/TD results; confirm all new tests are included in `test:agents`.
Run the milestone gate once. Check mixed old/new metadata, provider-session change,
state equality, and render scope as integrated paths. Review boundary-sensitive
diffs with the stronger coordinator; report specific defects, not a new redesign.

**Checks:** V-A-GATE. **Done:** deterministic acceptance rows have evidence and no
unexplained regression; real-provider rows remain pending until actually exercised.

### VERIFY-02 — provider evidence

**Read:** verification document's real-provider procedure.
**Own:** evidence matrix/documentation; scoped fixes only if separately assigned.

Record named host/account alias, provider version, model, exact tool operations,
revisions, and before/after UI observations for each selected provider. Reuse the
tiny prescribed prompt. Stop an unavailable provider at its actual blocker rather
than changing login/config or looping inference. Record fresh and resumed Codex
behavior separately if that route is claimed supported.

**Checks:** V-LIVE. **Acceptance:** TODO-AC9 and AG-11c evidence for tested rows.
**Inputs needed at execution:** selected SSH host/project and provider/model choices.

### VERIFY-03 — packaged Windows lifecycle

**Read:** verification document's Windows procedure and actual CI limitations.
**Own:** evidence/docs; packaging fixes only by explicit task assignment.

Use the new integrated commit's ARM64 build, exercise the details disclosure and
Todos in WebView2, restart offline, then reattach/resume. Check task identity and
draft persistence. Record build SHA, OS/WebView runtime, cases, and result. Follow
the user's then-current commit/push/workflow instructions; this plan alone is not
an instruction to publish a build.

**Checks:** V-WINDOWS. **Acceptance:** native portions of UI-AC4/5, TODO-AC6/7/9.
**Done:** exact native evidence is recorded; missing host/account rows stay visible.

### GIT-01 — bounded contract and parsers

**Read:** specification 04, Identity/API and Status collection.
**Own:** `src/agents/git.ts` (new types), pure parsing exports in
`src-tauri/agent-host/git-review.mjs` (new), `tests-agents/git-review.test.mjs`.

Parse real porcelain-v2/NUL and numstat fixtures, including renamed two-path entries,
unmerged states, submodules, awkward UTF-8 paths, invalid UTF-8, and truncated output.
No SSH or UI work in this packet. Use actual fixture bytes, not line-split approximations.

**Checks:** V-GIT, V-TYPE. **Acceptance:** parser portions of GIT-AC1/2/5/6.
**Handoff:** exported parser signatures and fixture coverage for GIT-02.

### GIT-02 — remote read helper

**Read:** specification 04, Remote execution, limits, and Diff views.
**Own:** `src-tauri/agent-host/git-review.mjs` and `tests-agents/git-review.test.mjs`.

Run fixed read-only Git commands through the helper, enforce byte/deadline bounds,
disable external helper execution, handle unborn/binary/conflict/symlink cases, and
return stable bounded results. Validate racing status/diff identity. Exercise a
private real Git fixture; repository files/index/HEAD must be unchanged by reads.

**Checks:** V-GIT. **Acceptance:** helper portions of GIT-AC1/2/4/5/6/7/9.
**Handoff:** helper request/response examples, exit handling, hostile-helper sentinel
results, and bounded payload size.

### GIT-03 — native SSH boundary

**Read:** specification 04, Identity/API and existing `open_agent_exec` callers.
**Own:** new `src-tauri/src/agent_git.rs`, command registration in `lib.rs`, narrowly
shared path helpers if necessary, `src/bridge/{nativeBridge,tauriBridge,agentMocks}.ts`.

Register typed IPC, bind snapshot IDs to actual authenticated host/connection/cwd,
stream helper input on a non-PTY channel, and own bounded cached raw entry identity.
Unknown/stale IDs cannot become arbitrary path reads. Browser adapter rejects the
remote operation; deterministic test fixture mocks it explicitly.

**Checks:** V-RUST-GIT, V-TYPE, SSH fixture part of V-GIT-REMOTE.
**Acceptance:** GIT-AC3/4/6/7/9 at the native boundary.
**Handoff:** native error codes and test fixture hooks for GIT-04.

### GIT-04 — repository inspector

**Read:** specification 04, Renderer lifecycle and Inspector UX.
**Own:** new `src/session/agentGit.ts`, `AgentChanges.tsx`, optional
`AgentRepositoryChanges.tsx`, narrow `AgentWorkspace.tsx`/CSS/diff-renderer changes,
`tests-agents/git-review.spec.ts`, shared fixture additions.

Add Repository/Conversation views and selected diff scopes. Read on explicit
boundaries, preserve readable stale results, reject late wrong-context responses,
and use the existing diff/drawer behavior. Historical summaries must still open
historical edits. Keep project/draft/session identity intact.

**Checks:** V-TYPE, V-GIT-UI and relevant existing Changes accessibility tests.
**Acceptance:** GIT-AC3/7/8 plus visible state coverage for GIT-AC1/2/6.
**Handoff:** UI captures, request-count/race tests, remaining native checks.

### VERIFY-04 — Git delivery gate

**Read:** verification matrix and GIT packet results.
**Own:** `package.json` test-script registration, scoped integration fixes, evidence
record, narrow current-behavior docs.

Run deterministic gates, inspect the real server checkout through the authenticated
agent connection, and verify Repository/Conversation views in a packaged Windows
build. Confirm manual edits appear after Refresh and no Git read mutates the repo.
Update AG-02a status only; downstream Git delivery/worktree tasks remain their own work.

**Checks:** V-B-GATE, V-GIT-REMOTE, relevant V-WINDOWS cases.
**Acceptance:** GIT-AC1–9 with named evidence or explicit blocked rows.

## Closeout format

For each accepted task, add its commit/diff reference, passed acceptance IDs, exact
check results, and blockers in the verification record. Mark its checkbox only
after review. A blocked test is not a passed test; a provider-specific missing input
need not prevent a separate completed implementation task from closing.
