# AG-11a — Provider capability audit

Audited: **2026-10-30**. **Inventory and minimal contract specification complete.**
AG-11's explanatory UI and live capability publication are subsequent work. The
current implementation focus is agent capabilities and todos; orb work is deferred
at the user's request.

**AG-18 implementation update (2026-10-30):** Still now owns a revisioned shared todo
list per conversation and exposes it to the app and provider tools. This is a Still
capability, not a claim that the provider's native `/plan`, `TodoWrite`, or task tools
are synchronized. See the [AG-18 roadmap](agents-roadmap.md#ag-18-conversation-todos-and-task-progress)
for adapter wiring and remaining live-call verification.

## Evidence scope

The audit inspected the actual Still adapters, native event/persistence boundary,
installed provider protocols, and relevant versioned source. It also initialized
fresh provider sessions in an empty temporary directory on this **local Linux
development host**. No model prompts were submitted. Those read-only inventory
checks do not establish authenticated inference, the user's selected SSH host, or
packaged Windows behavior. Startup can create empty provider-session records.

Keep these evidence levels distinct:

| Label | Meaning |
| --- | --- |
| **Live verified** | A named read-only operation or handshake succeeded against the installed provider |
| **Fixture verified** | Still translated a deterministic protocol fixture correctly |
| **Source verified** | Installed schema/source or a named adapter path establishes the contract |
| **Unverified** | No representative live operation establishes support for this installation/account/project |
| **Unsupported in Still** | The current integrated route does not implement the capability, even if the provider offers it |

An installed CLI, its general help output, and a model catalog are insufficient to
certify every feature. Capabilities belong to the actual transport/version and may
also depend on project configuration, model, or loaded extensions.

## Installed inventory and handshake results

All five executables resolved through this host's Node v25.8.1 installation.
Version checks succeeded. The four native drivers were exercised through
`src-tauri/agent-host/bridge.mjs`; Gemini was probed directly through its actual ACP
entry point, matching Still's launch and client-capability parameters.

| Provider | Installed version | Actual provider transport | Session startup | Catalog/configuration observed |
| --- | --- | --- | --- | --- |
| OpenCode | **2.0.29** | Private loopback HTTP V2 + SSE, wrapped in Still's ACP envelope | **Live verified** | Model, mode, reasoning; native session identity; conditional history support |
| Codex | **0.160.1** | App Server JSONL, wrapped in Still's ACP envelope | **Live verified** | Model/reasoning; paginated thread; conditional history support |
| Claude Code | **2.1.239** | Bidirectional stream-json, wrapped in Still's ACP envelope | **Live verified** | Model/mode options, commands, session identity |
| Pi | **1.4.0** (`@earendil-works/pi-coding-agent`) | Pi RPC JSONL, wrapped in Still's ACP envelope | **Live verified** | Model/reasoning, commands, persistent session identity, fork-boundary support |
| Gemini CLI | **0.46.0** | Direct ACP v1 JSON-RPC | **Initialize verified; session blocked** | Advertised load-session, image/audio/embedded context; actual session configuration unverified |

Gemini's configured account returned this session-start error:

> This client is no longer supported for Gemini Code Assist for individuals. To
> continue using Gemini, please migrate to the Antigravity suite of products:
> https://antigravity.google

This is the response of this installed account/configuration, not a conclusion that
Gemini's ACP protocol is universally unsupported. Leave its live session features
unverified until a usable configuration is supplied; do not change the user's login.

Additional live Codex readbacks succeeded: `collaborationMode/list` (two presets),
`permissionProfile/list` (three profiles), and `account/usage/read` (usage response).
Still currently consumes none of those inventories. These counts are observations,
not defaults or a reason to expose those controls without wiring their operations.

## Status and outcome inventory

| Provider | Structured source | Current Still translation | Gap / confidence |
| --- | --- | --- | --- |
| OpenCode | `session.execution.succeeded`, `.failed`, `.interrupted`; step/retry/compaction events | End/cancel/failure, retry notice; text/tool streams | **Source + fixture verified.** Interrupt reasons and step finish details are discarded; step failure alone is not execution failure. Live model outcomes unverified. |
| Codex | `turn/started`, `turn/completed`, `error`, `thread/status/changed`; approval/input requests | End/cancel/failure; tools and supported approval/input routes | **Source + fixture verified.** `thread/status/changed` is ignored; the completion branch treats non-failed/non-interrupted outcomes as normal end without validating the status enum. |
| Claude | `result`, `system.session_state_changed`, background-task lifecycle; tool permission requests | Settles after a result and observed child work; `is_error` becomes failure; local cancellation flag becomes cancelled | **Source + fixture verified.** Result subtype/usage and task detail are not retained as typed outcomes. Background task notifications are not checklist todos. |
| Pi | `agent_settled`, `agent_end`, `message_end`, retry and tool events | Settled end/abort; older `agent_end` checks live state; message errors/retry exhaustion become failure | **Source + fixture verified.** Message `length` and detailed terminal reasons are not preserved. `agent_end` is not necessarily the end of all automatic work. |
| Gemini | ACP prompt `stopReason`, `session/update`, `session/request_permission` | Direct ACP events and generic native request handling | **Source verified; live turns unverified.** Inspect actual session output after resolving startup; a schema accepting `plan` does not prove this provider emits plans. |

### Shared findings

1. **State alone cannot identify activity.** `working` with `turnActive: false`
   means ready. A local `threadStopped` means cancellation was requested, not confirmed.
2. **End reasons need a typed field when status work starts.** Native Rust accepts
   `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, and `cancelled`, but records
   all non-cancelled endings as `complete` and keeps the reason in display text.
3. **Maintenance shares completion plumbing.** Compact/reload and normal user turns
   can produce the same end signal. Preserve operation kind before using these events
   for completed-task semantics.
4. **Request responses and tool success differ.** Acknowledging a choice is not a
   completed tool, completed task, or finished turn.
5. **Observation and execution differ.** The server may keep running after SSH loss;
   neither quiet output nor disconnect proves it ended.

These are recorded integration gaps, not changes implemented by this audit.

## Todo capability matrix — immediate next feature

| Provider | Upstream task source | Structured todo reading in Still today | Direct client todo editing | Required next step |
| --- | --- | --- | --- | --- |
| **Codex** | `turn/plan/updated`: `threadId`, `turnId`, optional explanation, full plan snapshot; pending/inProgress/completed | **Supported by current mapping; source verified.** Adapter maps entries into `plan`. Live task emission remains unverified. | **Unsupported in Still.** Generated protocol exposes no dedicated plan-step write endpoint. | Preserve turn/list identity and explanation, retain snapshot-replacement semantics, and display through AG-18. |
| **Claude** | `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`, or legacy `TodoWrite` as tool calls/results | **Unsupported as a task projection.** Generic tool rows carry input/text, but structured `tool_use_result` is discarded. | **Unsupported in Still.** Tool availability does not imply a direct client task-write API. | Confirm active tool inventory for the selected version/model; pair acknowledged results with tool IDs; retain assigned task IDs and deletions before projecting progress. |
| **Pi** | No core RPC todo contract; bundled example extension registers `todo` and stores a full list in `result.details.todos` | **Unsupported as a task projection.** Generic `rawOutput` retains result details; extension availability/schema remain unverified. | **Unsupported in Still.** `/todos` in the example is interactive-TUI-only. | Require an explicitly identified compatible extension/result shape. Do not infer support from a generic tool name or install an extension automatically. |
| **OpenCode V2** | No built-in todo endpoint/event in the audited 2.0.29 schema/source; Plan is an agent mode | **Unsupported by current adapter.** Custom project/plugin task contracts are unverified. | **Unsupported in Still.** No verified native task-write operation. | Ship Still-owned checklist support independently; add provider task synchronization only for an actually advertised/observed contract. |
| **Gemini** | `write_todos` tool exists in installed CLI; generic ACP plan type exists | **Unverified for structured task synchronization.** Audited ACP tool path emits display content, without raw task input/output or a dedicated plan update. Session startup is blocked. | **Unsupported in Still.** No verified ACP client task-write route. | Resolve runtime access, capture a real enabled-tool result, and verify a structured payload before claiming synchronization. |

### Still-owned shared todo tool (separate from the matrix above)

Still adds one tool to supported provider integrations: `still_todos` with `list`,
`add`, `update`, `remove`, `move`, and `focus` actions. It edits the shared conversation
checklist, not provider-internal native task records. The app panel and provider tool
share the revisioned remote-worker store. The model is the sole writer; the app panel
only shows task names and binary Done/Not done status in a collapsible preview. Native
provider plan APIs remain separate from this common Still tool.

| Adapter | Registration path implemented | Verification boundary |
| --- | --- | --- |
| Codex | Native dynamic tool plus `item/tool/call` translation | App Server startup passed; one synthetic App Server tool request passed. Real model call remains unverified. |
| Claude Code | Per-execution local stdio MCP config | Local CLI startup and MCP list/tool-handshake reached the shared worker. Real model call remains unverified. |
| Pi | Per-execution Still RPC extension | Local RPC startup and extension session-start tool handshake passed. Real model call remains unverified. |
| OpenCode V2 | Runtime MCP server through the installed server API | Local OpenCode 2.0.29 server accepted configuration and connected to the shared worker. Real model call remains unverified. |
| Gemini CLI | ACP session `mcpServers` config | Initialized with ACP v1, but account rejected session creation. Tool support remains unverified and unavailable under this configuration. |

If the provider tool is unavailable, Still shows the cached list read-only. Remote
workers predating worker protocol v3 cannot handle the shared-list RPC; their cached
lists remain read-only until a v3 execution is started. Checklist state never changes
agent-turn, test, approval, or orb status.

### Todo correctness constraints

- Codex plan steps have **no stable task ID** in the generated 0.160.1 schema.
  Use the native turn plus a revision-scoped snapshot; duplicate step text is valid.
  The current adapter drops `turnId` and explanation from its plan projection.
- Claude's `TaskCreate` ID is assigned by the result, not the proposed input. A
  streamed tool call may fail; do not turn its proposed task changes into acknowledged
  progress. `system.task_started` / task notifications describe background work,
  not the task checklist.
- Current Claude documentation changes default task-tool availability starting at
  **2.1.268**, newer than the installed **2.1.239**. Treat this as version/model-sensitive
  guidance, not evidence that this host has those new defaults.
- Pi's bundled example resets its integer ID counter on clear. Scope extension tasks
  to a list generation and provider branch; a reused integer is not global identity.
- Gemini's generic ACP library understands `plan` and `usage_update`, but its concrete
  provider must emit usable data. Protocol vocabulary alone is not a capability probe.
- Native provider plan/task data remains distinct from the model-managed Still list.

## Other capability boundaries

| Feature | Provider evidence | Current Still integration |
| --- | --- | --- |
| Model/reasoning | Live native catalogs in four providers; Gemini configuration source only | Model controls supported where offered; reasoning not uniformly exposed |
| Agent/mode | OpenCode/Claude catalogs; Codex collaboration-mode readback; Gemini mode API source | OpenCode/Claude mode control; Codex mode inventory not integrated; Gemini live state unverified |
| Execution policy | Codex permission profiles read successfully; Claude initialize reports effective permission mode; Gemini ACP advertises modes | Partial mode/approval handling; effective sandbox/network policy not consistently published |
| Images/files | Codex versioned input schema, Pi `prompt.images`, OpenCode V2 file attachments, Gemini handshake | **Unsupported** in composer/send pipeline: native prompts are text-only |
| Queue/steer | Codex queue/steer methods; Pi `steer`/`follow_up`; OpenCode inbox delivery supports queue/steer | **Unsupported**; busy-send guards remain in force |
| Usage/context | Codex usage readback and token-usage schema; Pi stats/message types; OpenCode step token/cost data | **Unsupported** as normalized UI data; generic Rust `usage_update` is allowed through its filter but then discarded |
| Resume/history | Native session IDs in four live handshakes; runtime history checks in OpenCode/Codex/Pi | Resume references and capability-gated rewind already present; Claude conversation rewind unavailable |
| Gemini resume | `initialize.agentCapabilities.loadSession: true` | Native startup only reads `_meta.resumable` from the session reply, which Gemini's audited reply omits; advertised native resume is not retained |
| Import/fork | Codex fork/history APIs; Pi clone/fork and entries; OpenCode session APIs | **Unsupported** as general import/fork UI; existing Pi rewind internally uses fork |
| Subagents | Codex collab item schema; Claude lifecycle; OpenCode subagent tools | Generic tools/internal lifecycle only; no typed child-conversation view |
| File checkpoint rollback | Provider-dependent and distinct from conversation rewind | **Unsupported**; current Revert explicitly keeps project files |

## Minimal capability contract for the next implementation

Reuse the existing configuration, command, history-capability, and native snapshot
paths. This audit specifies the smallest addition; it does not introduce a plugin
framework or enable unfinished features.

| Fact | Where it belongs | Rule |
| --- | --- | --- |
| Installed version + transport | Optional discovery fields, repeated on the live session report | Exact executable/host scope; missing values stay unknown |
| Provider handshake facts | Existing ACP initialize/session reply and adapter `_meta` | Retain only recognized, bounded fields; no auth material or arbitrary raw responses |
| Feature support | Optional live session capability report | `supported`, `unsupported`, or `unverified`, with a short reason and evidence kind |
| Feature key | Begin with structured todo snapshots, task-result projection, and client task writes | Add other keys only when implementing their consumer |
| Scope | Current execution/provider session, project, model/configuration generation where relevant | Reconnect, resume, executable/model changes invalidate affected claims |
| Evidence | `advertised`, `observed`, or `adapter` plus observation time/version | Keep audit fixture evidence in docs/tests; a fixture must not mark a live host verified |

For a feature to be `supported` in Still, both the active provider contract and the
integrated operation must be available. An upstream API with no Still adapter is
`unsupported` in Still with that explanation. Missing dynamic evidence is `unverified`,
not implicitly false and not permission to dispatch. Existing live `configOptions`,
commands, and history checks remain their respective authority.

The native checker currently detects executable presence and Node readiness only.
It reports no provider version. The wrapped initialize response uses version
`"native"`; the Rust receiver keeps the agent name but discards actual initialize
capabilities. Replace those gaps when adding live capability publication, without
treating the hard-coded wrapper response as provider evidence.

## Follow-up tasks identified by this audit

- [ ] **AG-11a.1 — Publish observed capabilities:** add version/transport and the
  minimal supported/unsupported/unverified report to existing discovery/session
  data; preserve it across native snapshots with stale-on-resume behavior.
- [ ] **AG-18b — Real tool calls:** verify a generated `still_todos` call with each
  active provider/model on an explicitly authorized host. Codex native plan events and
  Claude/Pi/OpenCode/Gemini provider-native task representations remain independent.
- [ ] **AG-11c — Target-host evidence:** repeat installed-version/startup checks on
  the user's selected SSH account, then verify actual outcomes/tasks when live model
  execution is in scope. Gemini session startup remains an explicit evidence blocker.

The audit subtask is complete. AG-11 as a whole remains **IN PROGRESS**, including
the live publication follow-up, explanatory UI (AG-11b), and broader live evidence
(AG-11c). Orb implementation remains **DEFERRED**.

## Reproduce the inventory

From `still-app`:

```sh
node scripts/audit-agent-capabilities.mjs
node scripts/audit-agent-capabilities.mjs codex pi
env -u STILL_AGENT_DRIVER -u STILL_AGENT_EXECUTABLE -u STILL_AGENT_CATALOG node --test tests-agents/protocol.test.mjs
```

The script uses installed executables on the local PATH, starts the same native
drivers, prints metadata only, and closes the processes it starts. It reports missing
executables separately and exits nonzero for an installed provider whose session
cannot be initialized or whose cleanup fails. It submits no prompt or provider
configuration mutation; startup itself may persist empty sessions. The temporary
project path is printed for traceability.

The protocol suite passed **15/15** after clearing inherited host-entry variables.
With `STILL_AGENT_DRIVER` inherited from a Still-managed environment, importing the
driver can start its executable entry point inside a test peer, causing false
failures; the standalone audit script clears those role variables before import.

The recorded full inventory run reported `observedAt: 2026-10-29T21:12:21.527Z`
from the runtime clock (UTC); the project audit date above is 2026-10-30. It verified
four session startups and reported the Gemini blocker, correctly exiting with status
1 for that incomplete provider check. Script syntax and documentation links passed.

## Sources

- Still: `src/agents/types.ts`, `src/session/agentDiscovery.ts`,
  `src/session/agentThreads.ts`, `src-tauri/src/agent.rs`, and
  `src-tauri/agent-host/bridge.mjs`.
- [OpenCode V2 API](https://opencode.ai/v2/docs/api) and
  [client lifecycle](https://opencode.ai/v2/docs/build/client).
  Audited installed-tag source:
  [`042d0832f5f3a73eaa039a58a7d565776f6d4290`](https://github.com/anomalyco/opencode/tree/042d0832f5f3a73eaa039a58a7d565776f6d4290),
  particularly `packages/schema/src/session-event.ts`,
  `packages/core/src/session/execution.ts`, and built-in tool plugins.
- [Codex App Server](https://developers.openai.com/codex/app-server/). Exact installed
  schemas were generated by `codex app-server generate-json-schema --experimental --out <temporary-directory>`:
  `TurnPlanUpdatedNotification`, `ThreadStatusChangedNotification`,
  `ThreadTokenUsageUpdatedNotification`, `TurnCompletedNotification`, and request unions.
- [Claude todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking).
  Its 2.1.268+ availability note is newer than the installed runtime; live task-tool
  availability was not inferred from it.
- Installed Pi 1.4.0 `docs/rpc.md`, `docs/json.md`, `docs/rpc-commands.md`,
  `dist/modes/rpc/rpc-types.d.ts`, and `examples/extensions/todo.ts`, distributed by
  [earendil-works/pi](https://github.com/earendil-works/pi).
- Installed Gemini 0.46.0 `bundle/docs/cli/acp-mode.md` and bundled ACP
  initialize/session/tool translation source, plus the live initialize response.
