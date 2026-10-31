# Verification and evidence

Status: **implementation checks recorded below; live-provider and packaged Windows
evidence remain pending**. Commands run from `/mnt/data/still/still-app` after the
relevant implementation exists. The completed-evidence section records actual
results and distinguishes fixture checks from external verification.

## Evidence already available

| Fact | Evidence | Boundary |
| --- | --- | --- |
| SSH bootstrap startup fix | User confirmed it works after installing the fix | Startup regression resolved; provider/model details were not supplied in that confirmation |
| Todo implementation baseline | Commit `b82b469` and existing protocol/worker/UI tests | Registration/synthetic evidence, not all real model calls |
| Windows ARM64 baseline | Run `41069787267`, commit `4c30626`, success | Frontend build/typecheck, Rust unit gate, packaged architecture/native-glass checks |
| Local provider inventory | `docs/todo/provider-capabilities.md`, 2026-10-30 | Four local session startups; direct Gemini initialize then account blocker |

The Windows workflow's step labelled “Rust integration tests” conditionally skips
live SSH suites when `STILL_RUN_LIVE_SSH` is absent. A green step label alone does
not prove SSH/tmux or Todo operations ran. Inspect the actual log and record skips.

## Focused check catalog

Clear inherited driver-entry variables when running standalone Node protocol tests.
Tests must not inherit a production `STILL_TODO_SOCKET`/token and contact a real
conversation. Test children needing those values create their own private fixtures.

### V-TYPE

```sh
npm run typecheck
```

### V-BOOT

```sh
env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG -u STILL_TODO_MODULE -u STILL_TODO_SOCKET -u STILL_TODO_TOKEN -u STILL_TODO_PI_EXTENSION node --test tests-agents/bootstrap.test.mjs
```

Extend the existing large-payload regression when introducing a Todo seed. Assert
that every spawn boundary keeps arguments bounded, bootstrap sources/seed arrive
intact, and ACP messages still pass after the ready marker.

### V-PROTOCOL

```sh
env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG -u STILL_TODO_MODULE -u STILL_TODO_SOCKET -u STILL_TODO_TOKEN -u STILL_TODO_PI_EXTENSION node --test tests-agents/protocol.test.mjs
```

### V-WORKER

```sh
env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG -u STILL_TODO_MODULE -u STILL_TODO_SOCKET -u STILL_TODO_TOKEN -u STILL_TODO_PI_EXTENSION node --test tests-agents/supervisor.test.mjs
```

### V-TODO-STORE

`tests-agents/todos-store.test.mjs` is created by TD-01.

```sh
env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG -u STILL_TODO_MODULE -u STILL_TODO_SOCKET -u STILL_TODO_TOKEN -u STILL_TODO_PI_EXTENSION node --test tests-agents/todos-store.test.mjs
```

### V-RUST-AGENT / V-RUST-STORE

Run only the relevant command during a task:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib agent::tests::
```

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib agent_store::tests::
```

If fixture imports/environment affect the result, report the exact error and fix
the isolated fixture. Do not weaken native validation or change the user's provider
installation to make a deterministic test pass.

### V-CAP-UI / V-TODO-UI

These specs are created by CAP-05/UI-01 and TD-03 respectively. Existing
`tests-agents/playwright.config.ts` starts/reuses the port-1432 fixture server.

```sh
npx playwright test -c tests-agents/playwright.config.ts capabilities.spec.ts
```

```sh
npx playwright test -c tests-agents/playwright.config.ts todos.spec.ts
```

### V-GIT / V-RUST-GIT / V-GIT-UI

These tests/modules are created in Milestone B.

```sh
env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG -u STILL_TODO_MODULE -u STILL_TODO_SOCKET -u STILL_TODO_TOKEN -u STILL_TODO_PI_EXTENSION node --test tests-agents/git-review.test.mjs
```

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib agent_git::tests::
```

```sh
npx playwright test -c tests-agents/playwright.config.ts git-review.spec.ts
```

### V-A-GATE / V-B-GATE

At the end of each integrated milestone, run the following once. The coordinator
adds new Node test files to the existing `test:agents` script before the gate;
otherwise a green suite would silently omit them. Keep current Playwright
configuration and its real-app
entry tests. Do not broaden to unrelated terminal/orb suites without a touched path
or concrete regression reason.

```sh
env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG -u STILL_TODO_MODULE -u STILL_TODO_SOCKET -u STILL_TODO_TOKEN -u STILL_TODO_PI_EXTENSION npm run test:agents
```

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --bins
```

```sh
npm run build
```

`npm run build` already includes the TypeScript check. Once these checks pass,
repeat only after a new change, failure, or unresolved concern justifies it.

## Acceptance matrix

| Acceptance | Deterministic evidence | External/native evidence |
| --- | --- | --- |
| CAP-AC1 | Version probe success/timeout/missing/override; launch still works on version failure | Named target-host discovery |
| CAP-AC2 | Two discoveries resolve out of order for different overrides/connections | One reconnect/executable-switch smoke |
| CAP-AC3 | Fresh/resumed Codex, accepted-but-unconnected OpenCode, actual MCP/Pi acknowledgement, failed tool call | Generated tool call per selected provider |
| CAP-AC4 | Identical config repeats vs actual config change; provider session changes; old-generation event | One model change followed by a new tool call |
| CAP-AC5 | Disk stale, attach handshake stale, matching catch-up current, legacy absent report | Native offline restart/reattach |
| CAP-AC6 | Wrong host-context/session/cwd, unknown enum/schema, malformed/oversized report, stale generation | No paid inference needed |
| CAP-AC7 | Native header/event replay, checkpoint, renderer merge | Native app-data lifecycle |
| CAP-AC8 | Direct Gemini explicit loadSession fallback; wrapper cannot confer it | Gemini blocker recorded until actual startup succeeds |
| CAP-AC9 | No changed transcript projection, activity ordering, drafts, task content, or turn state | Routine UI observation |
| UI-AC1–3 | Current/prepared/saved scope; each report state; exact connection-vs-operation copy | WebView2 details disclosure |
| UI-AC4 | Keyboard/focus/compact/reduced motion and long content | WebView2 interaction at desktop/compact size |
| UI-AC5–6 | Draft, Todo pill, existing controls and disabled native-operation guard tests | Packaged smoke |
| TODO-AC1 | Pre-rename failure and post-rename uncertainty | Native filesystem journal check where relevant |
| TODO-AC2 | Drop tool reply then retry same ID; conflicting input; stale new-ID request | One reconnect after model mutation |
| TODO-AC3 | High event sequence with lower Todo revision; equal revision divergent content; readiness-only update | Native catch-up |
| TODO-AC4 | Two worker starts for one conversation; owner cleanup/recovery; separate conversations remain independent | One managed replacement execution |
| TODO-AC5 | ENOENT + seed; corrupt/symlink/owned-by-other file; lower/equal-conflicting remote state; oversized seed | Packaged resume from native saved history |
| TODO-AC6 | Revert/Retry, Pi session ID change, journal truncation/checkpoint, native row restore | Restart offline, reconnect, provider resume |
| TODO-AC7 | Legacy/disconnected/conflicted snapshot UI, no edit controls, pill/focus behavior | WebView2 offline/restore |
| TODO-AC8 | Last Todo completion while turn active and approval pending leaves both states intact | One live call sequence |
| TODO-AC9 | All deterministic checks plus matrix completeness | Actual generated calls and Windows lifecycle |
| GIT-AC1–2 | Private repositories covering nested cwd, staged/unstaged, unborn/detached, renames, conflicts, binary/submodule | Manual server edit visible after Refresh |
| GIT-AC3 | Late result after project/host/connection switch; expired and wrong-scope native IDs | Two selected server/project contexts if available |
| GIT-AC4 | External diff/textconv/pager/fsmonitor/filter sentinel commands never execute; hostile selection env is cleared | Authenticated remote helper |
| GIT-AC5 | Spaces/newlines/quotes/dashes/metacharacters/non-UTF8/symlink path fixtures | Linux remote path behavior |
| GIT-AC6 | Exact byte/entry/line/deadline bounds; truncated cannot appear clean | Native payload/deadline boundary |
| GIT-AC7 | Change HEAD/index/file during read; one retry then stale | Agent edit followed by refresh |
| GIT-AC8 | Source/scope tabs, history-summary link, keyboard drawer, request count | Packaged inspector |
| GIT-AC9 | Snapshot of HEAD/index/worktree before and after read; unchanged sentinels | Agent-only SSH connection; terminal PTY untouched |

## V-LIVE — minimum useful provider evidence

### Inputs

At execution time, obtain the actual selected SSH host/account, disposable project,
and installed provider/model choices. Existing auth and host-key trust apply. Do not
infer them from this machine's PATH or the historical audit. Credentials and tokens
do not belong in the evidence document.

Use the app's real native bridge and provider integration. An external OpenCode
session's own Todo tool is not evidence for Still's remote Todo implementation.
Prefer a low-cost tool-capable model already configured for each provider.

### Exact small prompt

```text
Verify Still's conversation Todo tool using only still_todos.
First list the existing tasks. Create two tasks named "Check tool connection" and
"Check restored list". Focus "Check tool connection" with detail "Verifying the
shared list", mark that first task completed, and leave "Check restored list"
pending. List once more and report the final revision and both task IDs.
Use the expectedRevision returned by the tool for every mutation. Do not inspect
or edit project files, run shell commands, or use provider-native task tools.
```

The verification prompts operate in dedicated empty conversations, so the expected
minimum final state is two tasks, one Done, one Not done. A fresh store would reach
revision 4 after add/add/focus/update; do not demand that exact number if a provider
legitimately reconciles with additional acknowledged tool calls. Compare the actual
returned revision and identities across tool, worker/native snapshot, and UI.

### Procedure

1. Record provider version/transport, model ID, app commit, OS, and anonymized
   host/account label. Verify that the chosen project is the intended disposable one.
2. Open a fresh conversation; inspect registration evidence before sending.
3. Submit the prompt once. Observe actual structured tool calls and replies, not
   just the model's prose assertion that it created tasks.
4. Check the app shows the same two IDs/statuses/revision; evidence changes from
   connection/advertisement to observed call.
5. On one available provider, change a supported model/config setting; verify
   stale/unverified evidence and observe a new list call scoped to the new setting.
6. On one representative provider, perform the native lifecycle sequence below.
7. For Codex, exercise a resumed provider session separately if resumed dynamic-tool
   support is claimed. A historical pre-feature session must stay unverified until
   actual current evidence exists.
8. Stop at the actual provider/account blocker. Keep other rows independent. A model
   refusing the requested tool is evidence of that test result, not proof the route
   is universally unsupported.

### Provider matrix — initial status

| Provider | Target-host version/model | Registration | Generated call | Native/UI match | Result |
| --- | --- | --- | --- | --- | --- |
| OpenCode V2 | Not yet recorded | Local baseline only | Pending | Pending | UNVERIFIED |
| Codex fresh | Not yet recorded | Local baseline only | Pending | Pending | UNVERIFIED |
| Codex resumed | Not yet recorded | Must verify current thread | Pending | Pending | UNVERIFIED |
| Claude Code | Not yet recorded | Local baseline only | Pending | Pending | UNVERIFIED |
| Pi | Not yet recorded | Local baseline only | Pending | Pending | UNVERIFIED |
| Gemini | Not yet recorded | Local initialize succeeded; session rejected | Pending | Pending | BLOCKED on audited account; target-host status unknown |

This matrix is evidence, not a hard-coded runtime support table. A provider version
or account change requires new evidence for affected operations.

## V-WINDOWS — packaged native lifecycle

Use a build for the integrated implementation SHA. `41069787267` is baseline
evidence only. The existing Windows workflow is manually dispatched; follow the
user's current release instruction for pushing/dispatching it.

1. Install/run the new ARM64 package and record its commit/build ID, Windows version,
   and WebView2 runtime version.
2. Open Agent details with keyboard, verify long-value layout, close with Escape,
   and confirm focus/draft remain intact. Exercise Todo expand/collapse.
3. Perform the real two-task prompt. Record the current list IDs and revision.
4. Disconnect SSH while keeping the worker alive. The list stays readable; provider
   evidence is stale, and no finished-turn claim comes from the last Todo changing.
5. Close/restart Still offline. Open saved history: draft, list, detail, completed
   duration, and provider metadata remain available with honest observation state.
6. Reconnect to the same worker. Catch up once without resending the original prompt
   or duplicating task mutation. Verify matching/latest revision.
7. Exercise an ordinary provider resume/new managed execution on that disposable
   conversation and confirm the same list. Missing-store/corruption injection stays
   in isolated deterministic fixtures unless explicitly needed for a native defect.
8. For supported Revert/Retry, verify messages rewind while current shared Todos
   remain; the next model tool call can list/reconcile them.
9. In Milestone B, inspect a real server edit in Repository; switch to Conversation;
   confirm drawer focus, offline state, and manual refresh.

If Firefox still fails in browser development, record/reproduce it separately.
Passing Chromium or WebView2 does not establish Firefox behavior. It is not a new
release gate for the Windows app unless the current change touches the reported
browser problem.

## V-GIT-REMOTE — real checkout read

Use a disposable repository on the selected SSH host. The fixture creator may
create commits/files for the test; the **review operations themselves must be
read-only**. Capture initial HEAD, raw index checksum, tracked/untracked content
hashes, and configured external-helper sentinel absence before the read.

Verify nested project cwd, staged-and-modified same file, rename, binary, untracked
file, clean state, and nonrepository folder. Make one manual server-side edit after
opening the inspector; Refresh must show it without a model invocation. Verify
connection/host switch discards late output and a timeout preserves stale readable
state. Compare the captured repository state after every review read.

The existing ignored native tests are available for related fixture setup:
`agent::tests::native_catalogs_initialise_over_verified_ssh_without_tmux` requires
localhost sshd and the configured test key; `agent_store::tests::native_app_data_survives_reload_and_preserves_resume_identity`
requires a Linux display. Invoke ignored tests only after satisfying their actual
fixture prerequisites. Do not count a skipped ignored test as completed evidence.

## Evidence entry format

Append one concise record per accepted packet or external run:

| Field | Required value |
| --- | --- |
| Task / acceptance IDs | Exact IDs from TASKS and the specification |
| Implementation | Commit SHA or clearly identified reviewed diff |
| Environment | OS/runtime and relevant host/provider/model; no secrets |
| Checks | Exact command, pass/fail counts, skipped cases |
| Observation | Actual state, IDs/revisions, or rendered behavior tested |
| Evidence location | Test output/capture/run URL retained by the implementing session |
| Blockers | Specific unavailable input or failing case; next action |

No evidence for the future work above has been manufactured by this planning pack.

## Completed evidence

### SETUP-01 — baseline adopted and pack imported

| Field | Value |
| --- | --- |
| Task / acceptance IDs | SETUP-01 (documentation gate only; no feature acceptance IDs) |
| Implementation | Documentation import onto HEAD `e25bb3d` (`Remove custom glass backdrop renderer`), uncommitted at time of writing |
| Environment | Local Linux development host, `/mnt/data/still/still-app` |
| Checks | Relative-link and code-fence scan over `docs/todo/next/*.md` → PASS (0 broken links, 0 unmatched fences) |
| Observation | Eight documents imported to `docs/todo/next/`; linked from `docs/todo/README.md`; user-confirmed startup fix recorded in the tracker; historical audit and roadmap left intact as dated evidence |
| Evidence location | This section plus `git status`/`git diff -- docs/todo` on the implementing session |
| Blockers | None for documentation. Source implementation of CAP-01 onward is still TODO |

The import deliberately did not modify source, provider configuration, or the
existing uncommitted UI work (`PRODUCT.md`, `src/bridge/agentMocks.ts`,
`src/components/SessionCard.tsx`, `src/session/connections.ts`, `src/styles/theme.css`,
`tests-agents/fixture.html`, `tests-m5/preview-regressions.mjs`,
`tests-terminal/card-fixture.tsx`, `tests-terminal/preview.spec.ts`), and left
`src/styles/agent-workspace.css.bak` untouched.

### CAP-01 — shared capability contract

| Field | Value |
| --- | --- |
| Task / acceptance IDs | CAP-01; foundation for CAP-AC1/5/6/7 |
| Implementation | `src/agents/types.ts`, uncommitted at time of writing |
| Environment | Local Linux development host |
| Checks | `npm run typecheck` → PASS (no diagnostics) |
| Observation | Added `AgentProviderTransport`, `AgentProviderRuntime`, `AgentCapabilityKey`, `AgentFeatureStatus`, `AgentFeatureEvidence`, `AgentFeatureSupport`, `AgentCapabilityReport`; `capabilities` on `AgentThreadSnapshot`/`AgentThreadEvent`; `capabilities` event type; optional `providerRuntime`/`checkedAt` on `AgentAvailability` |
| Evidence location | This section |
| Blockers | None. No runtime producer or consumer exists yet; CAP-02 begins runtime facts |

Legacy shape preserved: every new field is optional, `AgentAvailability.runtime`
keeps its coarse `native | acp` meaning, `AgentCatalog.version` is unchanged, and no
support default is synthesized in the type layer. The worker wire report omits
`freshness`, which is why the interface documents native-only ownership of it.

### CAP-02 — bounded runtime version discovery

| Field | Value |
| --- | --- |
| Task / acceptance IDs | CAP-02; CAP-AC1, native side of CAP-AC2 |
| Implementation | `src-tauri/src/agent.rs`, `src-tauri/agent-host/bridge.mjs`, `tests-agents/protocol.test.mjs` (uncommitted at time of writing) |
| Environment | Local Linux development host; fixture peers only, no real provider inference |
| Checks | `cargo check --manifest-path src-tauri/Cargo.toml` → PASS; `cargo test --lib agent::tests::` → 12 passed, 1 ignored (live SSH fixture); `node --test tests-agents/protocol.test.mjs` → 17 passed; `node --test tests-agents/supervisor.test.mjs tests-agents/bootstrap.test.mjs` → 8 passed; `npm run typecheck` → PASS |
| Observation | Discovery now reports `providerRuntime {transport, executable, version?, versionSource?, versionObservedAt?}` plus `checkedAt`; start carries the same facts through `providerRuntime` and `STILL_PROVIDER_RUNTIME`; the worker echoes them in session `_meta.providerRuntime` and replaces the version with the running OpenCode server version |
| Evidence location | This section and the new fixture tests |
| Blockers | No named target host was exercised, so real installed versions are still unrecorded. **CAP-AC2 is not complete** until CAP-05 scopes renderer discovery results |

Probe bounds: one bounded mission per provider, `--version` only, 2-second child
timeout with `SIGKILL` and a 16 KiB `maxBuffer`, output normalized to at most 200
characters, at most five entries, and the whole discovery path shares the existing
15-second deadline. Version failure leaves the version absent and reports
"Installed. The selected executable did not report a version." rather than changing
the installed/launchable state. `probe_runtime` failure never blocks a launch and
returns transport/executable without a version.

Truthfulness: `agentInfo.version: "native"` remains the adapter's own ACP label and
is never presented as a provider version; the fixture test asserts the session
`_meta` does not claim it. Malformed `STILL_PROVIDER_RUNTIME` is ignored, leaving
only launch facts. Reattach (`create: false`) deliberately carries no runtime
payload, so a newer executable on disk cannot relabel a running worker.

### TD-01 — transactional Todo mutations

| Field | Value |
| --- | --- |
| Task / acceptance IDs | TD-01; TODO-AC1, TODO-AC2 |
| Implementation | `src-tauri/agent-host/todos.mjs::createTodoStore`, new `tests-agents/todos-store.test.mjs` |
| Environment | Local Linux development host, untrusted-filesystem style fixture under `/tmp/opencode` |
| Checks | `node --test tests-agents/todos-store.test.mjs` → 4 passed; `node --test tests-agents/supervisor.test.mjs tests-agents/bootstrap.test.mjs tests-agents/todos-store.test.mjs` → 12 passed; the same suite run against `HEAD` `todos.mjs` → 1 failing test, confirming the regression actually covers the defect |
| Observation | Candidate items/`activeId` are built locally and assigned only inside `persist` after a successful rename; pre-rename failure leaves revision, focus, timestamps, and receipts unchanged, and the same request ID then succeeds on retry |
| Evidence location | This section and the failing-before/passing-after run |
| Blockers | A true post-rename directory-fsync failure has no injection point; TODO-AC1's "post-rename uncertainty" is covered by the receipt-replay test, which proves a lost reply still reports committed state |

`tests-agents/todos-store.test.mjs` is **not yet registered** in the `test:agents`
script; VERIFY-01 owns `package.json` and must add it before the milestone gate, or a
green suite would silently omit these cases.

### CAP-03 — worker-owned capability report

| Field | Value |
| --- | --- |
| Task / acceptance IDs | CAP-03; CAP-AC2 evidence rules, CAP-AC3, CAP-AC5, CAP-AC6 |
| Implementation | `src-tauri/agent-host/supervisor.mjs`, `bridge.mjs` (Codex resume, OpenCode MCP readiness), `tests-agents/supervisor.test.mjs` |
| Environment | Local Linux development host, fixture ACP peers; no provider inference |
| Checks | `node --test tests-agents/supervisor.test.mjs` → 9 passed; combined bootstrap/protocol/supervisor/todos-store → 31 passed; `cargo test --locked --lib --bins` → 51 passed, 2 ignored; `npm run typecheck` → PASS |
| Observation | Session `_meta.capabilities` carries `schemaVersion 1`, execution/agent session IDs, `cwd`, `configGeneration 0`, `observedAt`, launch `providerRuntime`, and all four features; `_still/capabilities_changed` is published, journal-flushed, replayed, and included in `_still/caught_up` |
| Evidence location | This section, the two new supervisor tests, and the `protocol.test.mjs` runtime assertions |
| Blockers | Real provider registration/call evidence is still unrecorded (VERIFY-02). Renderer consumption is CAP-05 |

Distinctions now enforced by the worker:

- `advertised` requires a real acknowledgement — MCP `tools/list`/Pi extension load,
  a fresh Codex thread, or an accepted tool call. OpenCode accepting an MCP
  configuration write is **not** readiness, and a resumed Codex thread no longer
  claims a tool it never confirmed.
- `observed` requires a successful authenticated `_still/todos` request in the current
  configuration; a `list` counts, an unauthenticated request does not.
- `providerPlans` is `unsupported` for Pi/Claude/OpenCode, `unverified` for
  Codex/Gemini until a `plan` update arrives, and `observed` afterwards. Gemini's
  `initialize` version is the only runtime version taken from ACP; the wrapper's
  `"native"` label is explicitly rejected.
- A semantic settings change increments `configGeneration` exactly once even when the
  provider notification and response acknowledgement both arrive; observed Todo and
  plan evidence is cleared, while execution-scoped tool registration is retained
  (the thread/MCP route still exists in the new generation).
- `providerTaskProjection` and `clientTodoWrite` remain `unsupported` with bounded
  reasons; no protocol version bump.

### CAP-04 — native report validation and freshness

| Field | Value |
| --- | --- |
| Task / acceptance IDs | CAP-04; CAP-AC5/6/7/8/9 at the native boundary |
| Implementation | `src-tauri/src/agent.rs`, `src-tauri/src/agent_store.rs` |
| Environment | Local Linux development host; unit/fixture evidence only, no SSH provider session |
| Checks | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --bins` → 58 passed, 2 ignored; focused capability validation/order/restore tests → PASS; library stale-scope test → PASS; Node bootstrap/protocol/supervisor/Todo-store tests → 32 passed; `npm run typecheck` → PASS; `npm run build` → PASS with existing Vite chunk/dynamic-import warnings |
| Observation | Native validates payload size, exact execution/provider-session/cwd identity, selected-agent transport, bounded reason/version fields, safe integer times/generations, all four known feature keys and evidence rules; it constructs the typed report itself, ignores worker freshness/unknown keys, rejects promotions of fixed-unavailable features, ignores older generations/cursors, persists reports in snapshot headers/events, and emits current/stale transitions |
| Evidence location | New `agent::tests` validation/order/restore/resumability cases, `agent_store::tests::library_capabilities_are_scope_validated_and_always_stale`, and this section |
| Blockers | `npm run test:agents` ran 107 Playwright tests successfully but failed `tests-agents/materials.spec.ts:104` because `.agent-workspace` lacked `data-frost-rendered="true"`; unrelated to CAP-04 paths, but suite remains non-green. `cargo fmt --check` also proposes broad changes across `agent.rs` and unrelated Rust modules/tests; no repository-wide formatting was applied. |

Freshness rules: saved/library reports are validated and shown stale; transport loss
marks the last accepted report stale; reattach remains stale until `_still/caught_up`
provides a matching report. Capability notifications received during replay remain
stale, then the caught-up report can promote them to current. Invalid optional reports
retain the previous accepted report as stale, emit one bounded notice per distinct
failure, and do not fail the provider turn. Capability events update the durable
header/transcript without changing conversation `activityAt`; the store test guards
that exclusion. No ACP protocol version or legacy history contract changed.

The two ignored Rust tests require GUI/localhost-SSH fixtures. Real provider runtime,
registration, tool-call, and Gemini load-session evidence remains VERIFY-02; CAP-05
still owns renderer freshness/reconciliation.

### CAP-05 — renderer reconciliation and selection-scoped discovery

| Field | Value |
| --- | --- |
| Task / acceptance IDs | CAP-05; CAP-AC2/5/6/7/9 at the renderer boundary |
| Implementation | `src/session/agentDiscovery.ts`, `src/session/agentThreads.ts`, scoped discovery callers in `src/components/AgentWorkspace.tsx`, `tests-agents/capabilities.spec.ts`, fixture probe additions |
| Environment | Local Playwright Chromium fixture; deterministic deferred availability replies |
| Checks | `npm run typecheck` → PASS; `npm run build` → PASS with existing Vite warnings; `npx playwright test -c tests-agents/playwright.config.ts capabilities.spec.ts workspace.spec.ts --reporter=dot` → 61 passed; full `npm run test:agents` → 110 passed, 1 failed (materials frost contract, below) |
| Observation | Capability reports reconcile as row metadata only, require matching attempt/execution/session/cwd, reject lower generations, never add capability events to transcript/activity, and turn saved reports stale. Discovery identity is native `transportId` plus the trimmed known-provider override map in `AGENTS` order; host cache and in-flight dedupe are tagged, old responses cannot overwrite a newer selection, persisted results start stale, and preparation/start require a fresh matching result. Auto-discovery and manual Refresh use the same selected-executable request rule; settings edits do not launch checks per keystroke |
| Evidence location | `tests-agents/capabilities.spec.ts`: report scope/generation/restore and delayed A/B selection race; `workspace.spec.ts`: 59 existing workspace tests |
| Blockers | Full suite still fails only `tests-agents/materials.spec.ts:104`: expected `.agent-workspace[data-frost-rendered="true"]`, received no attribute. This UI/material fixture is outside CAP-05; do not claim the full gate green |

Handoff to UI-01: `useAgentDiscovery(host, selectionKey)` returns `stale`,
`selectionKey`, `checking`, preserved cached `agents`, and `error`; the current settings
summary prefixes cached data with “Cached ·”. `AgentThreadRow.capabilities` is the
renderer source of truth. UI-01 can render freshness and feature reasons without
re-reading transcript events or changing operation guards. The existing Refresh
button commits a changed executable selection; the input itself only marks that
selection stale, so typing never launches probes.

### UI-01 — “Supported by this agent” disclosure

| Field | Value |
| --- | --- |
| Task / acceptance IDs | UI-01; UI-AC1–6 (browser-fixture coverage) |
| Implementation | New `src/components/AgentCapabilities.tsx`; narrow `AgentWorkspace.tsx` and `agent-workspace.css` changes; `tests-agents/capabilities.spec.ts` and fixture extensions |
| Environment | Local Linux Chromium via Playwright; packaged WebView2 not available here |
| Checks | `npm run typecheck` → PASS; `npm run build` → PASS with existing Vite warnings; `npx playwright test -c tests-agents/playwright.config.ts capabilities.spec.ts` → 2 passed; capability + workspace subset → 61 passed. Full `npm run test:agents` → 108 passed, 3 failed (two Windows/native-glass pixel/profile checks and one particle-budget check; these do not cover the new disclosure). |
| Observation | Current/prepared execution gets one text trigger on its host/folder context line. The nonmodal `role=dialog` shows version/transport, wrapping executable, current/stale observation, and four status/evidence rows. It distinguishes advertised from observed Todos, unavailable integration features, connecting/legacy/unknown-version/stale/refresh-failure states, and only exposes snapshot Refresh for an available live execution. Settings now show discovery-only version, transport, and last-checked data with cached marking. |
| Evidence location | `tests-agents/capabilities.spec.ts` covers no-report/unknown version, advertised/observed copy, connecting/stale/legacy, refresh failure, old attempt/generation handling, transcript/activity exclusion, keyboard/focus, outside dismissal, scope change, long strings, four viewport sizes, and reduced motion; existing `workspace.spec.ts` covers composer, model and Todo behavior |
| Blockers | **UI-AC4 remains pending packaged Windows WebView2 verification**: test one keyboard open/close/focus-return interaction in the packaged app before marking UI-01 complete. Current Linux Playwright is not a substitute. Full-suite failures are in untouched glass-pixel/Windows-profile/particle-budget fixture paths; do not change them under this task |

The disclosure owns no provider call and never enables controls. Refresh calls only
`refreshAgentThread` for the selected execution; errors are bounded and local to the
open panel, while the last report remains visible. No model, prompt, credential,
installation, Todo mutation, or history operation is triggered by opening it.

### TD-02 — conversation ownership and private missing-store recovery

| Field | Value |
| --- | --- |
| Task / acceptance IDs | TD-02; TODO-AC4/5 |
| Implementation | `src-tauri/agent-host/{bootstrap,supervisor,todos}.mjs`, seed/resume scope in `src-tauri/src/agent.rs`, focused bootstrap/worker/store tests |
| Checks | `env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG -u STILL_TODO_MODULE -u STILL_TODO_SOCKET -u STILL_TODO_TOKEN -u STILL_TODO_PI_EXTENSION -u STILL_PROVIDER_RUNTIME node --test tests-agents/bootstrap.test.mjs tests-agents/protocol.test.mjs tests-agents/supervisor.test.mjs tests-agents/todos-store.test.mjs` → **40 passed**; `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --bins` → **61 passed, 2 ignored**; `npm run typecheck` and scoped `git diff --check` → PASS |
| Observation | A private exclusive `owner.lock` contains execution ID/PID; a second upgraded worker fails before opening the shared list. Shutdown, confirmed provider exit, and early startup failure release only the acquired owner. Retired authenticated tools cannot mutate after replacement. Native validates the saved host/account, folder, provider/session and resume state before transmitting a seed and rejects replacement of a still-managed legacy execution. |
| Seed evidence | A 100-item list with 500-code-point titles/details exceeds 128 KiB, travels through SSH stdin, is stored at fixed `todo-seed.json` (0600), and is removed from both subsequent process arguments. The actual supervisor reads the maximal seed and its authenticated Todo tool returns it successfully. |
| Safety evidence | Bounded no-follow/nonblocking private reads reject symlinks, non-files and oversized seeds. Only ENOENT permits initialization; existing valid/newer stores win unchanged, while equal-divergent/newer-seed/corrupt originals remain inspectable. Failed recovery preserves its seed and releases its lock. |
| Remaining boundaries | Stale/ambiguous owner locks are never automatically reaped. An unmodified legacy worker on another device cannot be constrained by this new lock; native guards protect known executions only. The full agent UI run was interrupted; the earlier unrelated native-glass/profile/particle checks remain separate gate findings, not a TD-02 pass. |

### TD-03 — revision, observation and history reconciliation

| Field | Value |
| --- | --- |
| Task / acceptance IDs | TD-03; TODO-AC3/6/7/8 |
| Implementation | Todo paths in `src-tauri/src/{agent,agent_store}.rs`, `src/agents/{types,todos}.ts`, `src/session/agentThreads.ts`, contextual status in `AgentTodos.tsx` and its caller; new `tests-agents/{todos.spec.ts,todos-reconcile.test.mjs}` |
| Checks | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --bins` → **65 passed, 2 ignored**; `node --test tests-agents/todos-reconcile.test.mjs` → **3 passed**; `npx playwright test -c tests-agents/playwright.config.ts todos.spec.ts capabilities.spec.ts workspace.spec.ts --reporter=dot` → **68 passed**; `npm run typecheck` and scoped `git diff --check` → PASS |
| Observation | Same revision requires equal items/order/active ID but permits service/readiness changes. Lower ordinary replay is ignored; lower authoritative catch-up or equal-divergent state retains the accepted list and marks conflict. Invalid optional Todo state is nonfatal. Optional `todoSync` carries current/stale/conflict/unavailable observation separately from service flags and is persisted in native headers. |
| Persistence evidence | Native checkpoint/Revert/provider-session replacement test retains the latest list even after its introducing event disappears; restart converts current observation to stale. Renderer tests retain IDs, task details and fixed completed durations through Revert, Retry, offline reload, provider resume and persistent reconnect without resending prompts. |
| UI evidence | Todo metadata bypasses transcript/activity/turn accounting; completed tasks cannot finish a turn or approve a request. One bounded native snapshot refresh per execution/revision reconciles renderer-only conflicts without loops. Stale/conflict/unavailable copy is contextual, read-only and preserves the small attached Todo pill and normal composer geometry. |
| Remaining boundaries | Live native restart and packaged WebView2 checks remain VERIFY-02/03; the two ignored Rust tests need their GUI/SSH fixtures. UI-01's browser implementation is integrated while its required packaged keyboard/focus evidence is still pending. |
