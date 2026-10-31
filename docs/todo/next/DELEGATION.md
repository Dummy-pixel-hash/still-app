# Cost-efficient implementation handoff

## Operating rule

Use a **budget coding model for the bounded packets in TASKS.md**. Keep one primary
builder session per sequential stream so it can reuse its small working context.
Use a stronger model for specific unresolved contract/boundary reviews rather than
asking every model to rediscover the whole project.

No implementation agents were launched by this planning session. The user intends
to delegate after the specs are ready. Switch to a build-capable agent first.

## Choose a model at handoff time

The provider/model ID is intentionally not guessed here. Discover currently
available model IDs and prices with the OpenCode model tool when the user chooses a
model, then pass the exact returned reference. Account subscriptions, cached context,
and route-specific pricing can make nominal per-token prices misleading.

Selection priorities: reliable repository editing, TypeScript/Node competence, Rust
competence for native packets, enough context for one spec and its named files, and
consistent tool use. A small model that needs repeated full rewrites is not cheap.

Use the following assignments:

| Work | Default owner |
| --- | --- |
| Type definitions, fixture coverage, scoped UI, docs | Budget builder |
| Runtime probe, bounded Git parser/helper, renderer reconciliation | Budget builder with this fixed contract |
| Worker generations, Todo durable-state/ownership, native identity validation | Budget builder; stronger review of the resulting boundary diff |
| Provider evidence | Budget execution agent/operator; record facts, do not infer them |
| Cross-stream integration or a demonstrated ambiguity | Coordinator/stronger model with a small escalation packet |

## Minimum context per packet

Always provide:

1. Repository/worktree path and chosen baseline SHA.
2. This pack's README (especially existing user changes) and the single assigned
   task block from TASKS.md.
3. The referenced specification; include another only when the task depends on it.
4. Relevant verification command IDs/acceptance rows, not every test log.
5. Any accepted upstream contract/example output and the exact owned-file list.

Avoid copying the original long conversation, the entire provider audit, and all
four specs into every worker. The named source paths and symbols are the starting
points. The builder must still inspect current code and every caller it changes.

## Dispatch order

Default low-overhead sequence:

```text
SETUP-01 → CAP-01 → CAP-02 → TD-01 → CAP-03 → CAP-04
→ CAP-05 → UI-01 → TD-02 → TD-03 → VERIFY-01
→ VERIFY-02 / VERIFY-03
→ GIT-01 → GIT-02 → GIT-03 → GIT-04 → VERIFY-04
```

Two-agent option after the contract lands:

- **Stream A:** CAP-02, then CAP-03/CAP-04 after TD-01 is integrated.
- **Stream B:** TD-01; later TD-02 while Stream A handles CAP-05/UI-01.
- Coordinator integrates before TD-03, which shares both streams' files.

Use separate worktrees only from the chosen baseline including accepted prerequisite
changes and the spec pack. Existing dirty edits are not automatically present in a
new worktree. Do not copy them wholesale, stash them, or assume they are disposable.
Two writers never edit the same working directory concurrently.

If using NodeTerm later, use its orchestration workflow and dependency-aware
`--after` scheduling. Read every completed station's result before accepting it.
The plan does not require NodeTerm; normal sequential task sessions are sufficient.

## Copy-paste builder prompt

Replace the bracketed dispatch fields with actual values before sending this prompt.
They are assignment inputs, not missing implementation content in the specifications.

```text
Implement TASK [TASK-ID] in [WORKTREE-PATH], based on [BASE-SHA].

Read:
- docs/todo/next/README.md
- the [TASK-ID] block in docs/todo/next/TASKS.md
- [SPEC-FILENAME]
- its named checks in docs/todo/next/VERIFICATION.md

Owned files: [EXACT-OWNED-FILES-FROM-TASK].
Accepted upstream result: [UPSTREAM-COMMIT-OR-CONTRACT-SUMMARY].

Inspect current code and all affected callers before editing. Implement the smallest
complete diff satisfying the assigned contract. Reuse existing helpers, dependency
versions, native bridge, journals, controls, and fixtures. Add no dependencies.
Preserve unrelated user edits and accepted UI behavior.

Validate IDs, paths, versions, revisions, and sizes at their owning boundary. Missing
evidence stays unverified. Do not replace a real native failure with browser mocks,
invent provider protocol fields, or mark synthetic evidence as a live provider test.

Run only the task's focused checks. Include newly introduced tests in the appropriate
existing test script when this task owns package.json; otherwise flag that integration
step in the handoff. Do not edit global provider/account config or run paid provider
prompts unless this is the explicit evidence task.

Do not push, dispatch release workflows, reset/stash existing work, or expand into
another roadmap feature. Commit policy for this packet: [COORDINATOR-POLICY].

Return: task ID; changed files; acceptance IDs passed; exact test results; remaining
blockers; any contract deviation. If a fixed contract cannot be met, show the precise
code/protocol evidence and smallest proposed correction before implementing a new
architecture. Finish this packet completely, then return it for integration.
```

If the pack has not yet been imported, use
`/home/Darsh/.opencode/plan/still-agents-next/` for the read paths and assign SETUP-01
first. A worker on another machine must receive the docs before dispatch.

## First useful coding assignment

After SETUP-01, dispatch **CAP-01**. It freezes the small TypeScript contract without
requiring inference, SSH access, or a native build. Follow with CAP-02; TD-01 is the
best independent second packet if parallel work is worth the extra session.

CAP-03 and TD-02 deserve a focused stronger review because they touch capability
authority and shared durable state. Their implementation should still be small and
test-driven against the specified failure cases.

## Result format

```text
Task:
Baseline / resulting commit or diff:
Changed files:
Acceptance IDs passed:
Checks executed (command and result):
Skipped / blocked checks (specific reason):
Observed behavior / fixture evidence:
Contract deviations:
Ready for dependent task:
```

The coordinator checks the diff against file ownership, runs the relevant integration
gate once after merging, and updates TASKS/VERIFICATION. Task completion messages
alone are not evidence of correctness.

## Bounded escalation

Escalate a **specific** case when:

- A real provider schema contradicts the specified adapter contract.
- Durable store ownership or recovery cannot preserve the stated invariants.
- The proposed IPC shape cannot express an observed lifecycle state.
- Two focused diagnostic iterations leave the same failure unexplained.
- The necessary fix would cross task ownership or broaden the feature scope.

Send the coordinator: task/acceptance ID, relevant function/file slice, failing test
or response, attempted fixes, and one smallest proposed change. Do not restart a full
repository audit or feed the entire session history to another model. Continue other
independent assigned work while an external environment input is unavailable.

## Reviewer prompt

```text
Review the integrated [TASK-IDS] diff against docs/todo/next/[SPEC-FILENAME].
Read the builder's short result and failing/passing evidence, then inspect only the
changed boundary functions and their callers. Check identity/scope, invalid/stale
data, durable-write ordering, legacy compatibility, and the named acceptance cases.
For UI packets also check keyboard focus, compact layout, and existing interaction.

Return actionable defects with file/symbol and a minimal fix, or state that no
blocking defects were found within the reviewed scope. Distinguish tests inspected
from tests executed. Do not edit files or redesign unrelated code in this review.
```

## Cost controls that preserve quality

- One small task/spec per worker; preserve useful context across adjacent tasks.
- Deterministic protocol/filesystem fixtures before paid provider inference.
- One tiny generated-call prompt per provider; repeat only a failed changed path.
- Stronger model for concrete ambiguity/review, not repeated scaffolding.
- Reuse installed dependencies and the current architecture.
- Finish accepted scope and report remaining evidence honestly rather than expanding
  to a second feature or declaring untested work complete.
