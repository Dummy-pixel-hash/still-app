# Specification 01 — runtime capability publication

Roadmap: **AG-11a.1**, data foundation for **AG-11b/c**.
Depends on the existing worker protocol, discovery, and native history.

## Outcome

For the selected conversation, Still can explain which provider/runtime is actually
in use and what evidence exists for the currently integrated task features. Saved or
disconnected evidence remains readable without appearing freshly verified.

## Existing extension points

| Path / symbol | Existing behavior | Required extension |
| --- | --- | --- |
| `src/agents/types.ts` | Availability, events, snapshots, history flags, Todos | Optional runtime/report fields and one event variant |
| `src/session/agentDiscovery.ts` | Host-keyed cache and in-flight deduplication | Distinguish executable selections and stale installation results |
| `src/session/agentThreads.ts` | Snapshot/event reconciliation and restore | Store reports, invalidate freshness, reject cross-attempt evidence |
| `src-tauri/src/agent.rs::still_agent_check` | Resolves executable and Node presence | Bounded actual version probe and transport identity |
| `src-tauri/src/agent.rs::{handle,update}` | ACP initialize/session/update handling | Validate report, preserve identities, emit capability metadata |
| `src-tauri/src/agent.rs::Snapshot::history_header` | Copies durable snapshot fields | Include the optional report |
| `src-tauri/src/agent_store.rs::fields` | Journal snapshot headers | Include the optional report; preserve backward compatibility |
| `src-tauri/agent-host/bridge.mjs::createHost` | Native adapters wrapped in ACP | Add real provider runtime metadata to session result `_meta` |
| `src-tauri/agent-host/supervisor.mjs` | Owns worker state, replay, tool readiness | Own the report's generation and observed evidence |

`createHost` currently emits `agentInfo.version: "native"`. That describes neither
an installed provider version nor a successful capability probe. Never display it
as the provider version. `OpenCodeDriver.version` already obtains the V2 server's
actual version; reuse it.

## Contract

Use these names end-to-end. Rust serialization remains camelCase. These are proposed
schema definitions, not instructions to introduce a generic capability framework.

```ts
type AgentProviderTransport =
  | "http-v2+sse"
  | "codex-app-server"
  | "claude-stream-json"
  | "pi-rpc"
  | "acp-v1"

interface AgentProviderRuntime {
  transport: AgentProviderTransport
  executable?: string
  version?: string
  versionSource?: "runtime" | "executable"
  versionObservedAt?: number
}

type AgentCapabilityKey =
  | "sharedTodos"
  | "providerPlans"
  | "providerTaskProjection"
  | "clientTodoWrite"

interface AgentFeatureSupport {
  status: "supported" | "unsupported" | "unverified"
  reason: string
  evidence?: "adapter" | "advertised" | "observed"
}

interface AgentCapabilityReport {
  schemaVersion: 1
  executionId: string
  agentSessionId: string
  cwd: string
  configGeneration: number
  observedAt: number
  providerRuntime: AgentProviderRuntime
  features: Record<AgentCapabilityKey, AgentFeatureSupport>
  freshness: "current" | "stale"
}
```

Add:

- `AgentAvailability.providerRuntime?: AgentProviderRuntime` and `checkedAt?: number`.
  Keep its existing coarse `runtime: "native" | "acp"` field.
- `AgentThreadSnapshot.capabilities?: AgentCapabilityReport`.
- `AgentThreadEvent.capabilities?: AgentCapabilityReport` and event type
  `"capabilities"`.

The worker's wire report has the same fields **except `freshness`**. Only the native
observer/renderer can say whether its transport observation is current. `hostKey`
and `conversationId` are inherited from the containing snapshot, not repeated in
each feature. `AgentCatalog.version` remains compatible with its current callers.

### Meaning of the four keys

| Key | Meaning |
| --- | --- |
| `sharedTodos` | The running provider can access Still's conversation-scoped `still_todos` route |
| `providerPlans` | This integration can consume structured provider-native plan snapshots |
| `providerTaskProjection` | Provider-native task results are projected into a structured task view |
| `clientTodoWrite` | The user can directly mutate Todos from the Still app |

`clientTodoWrite` is deliberately `unsupported`, with an adapter reason that the
agent owns changes. `providerTaskProjection` remains unsupported in the inspected
adapters. Do not implement either feature as part of publishing the explanation.

## Facts and evidence

### Runtime identity

| Provider | Transport | Version precedence |
| --- | --- | --- |
| OpenCode | `http-v2+sse` | Actual `/api/info` server version; executable probe is fallback |
| Codex | `codex-app-server` | A recognized actual initialize version if available; otherwise selected executable `--version` |
| Claude | `claude-stream-json` | A recognized runtime version if available; otherwise selected executable `--version` |
| Pi | `pi-rpc` | A recognized runtime version if available; otherwise selected executable `--version` |
| Gemini | `acp-v1` | Direct ACP `agentInfo.version`; executable probe is fallback |

Do not guess version fields in opaque provider replies. Unknown version is valid.
The audit's installed versions are historical evidence, never runtime defaults.

Extend the existing native executable-detection helper so discovery and a fresh
selected-provider start reuse the same bounded probe. Probe the **resolved selected
executable**, including overrides, in the remote login environment. Pass the
launch-time runtime metadata in the existing worker bootstrap configuration; the
wrapper's session `_meta.providerRuntime` may replace its version with stronger
runtime evidence. Reattach reads the existing worker's runtime: a newer executable
on disk must not relabel an already-running old process.

Probe rules:

- Use executable + argument array, with `--version`; executable input retains the
  existing absolute-path-or-known-command validation.
- A short Node stdlib `execFile` probe inside the existing SSH detection command is
  sufficient. Reuse its source/helper for selected-provider startup; no new package.
- Each version child has a **2-second timeout**, **16 KiB combined retained output**,
  and cleanup on timeout. The existing overall discovery deadline is **15 seconds**.
- At most five known providers are examined per discovery; independent version
  probes may run concurrently. Start probes only the selected provider.
- Keep at most 200 Unicode characters of normalized version text; remove ANSI and
  control characters. Successful exit plus nonempty printable output is required.
- A version failure leaves the field absent and a bounded reason; it does not change
  a correctly detected installed/launchable provider into “not installed”.
- Put a useful discovery failure reason in the existing `AgentAvailability.message`
  field; absent version metadata otherwise renders “Version not reported”. Do not
  add an unconsumed diagnostics object.
- Detection never starts model inference or creates an agent session.

### Initial feature states

| Feature/provider | Initial evidence rule |
| --- | --- |
| Shared Todos, any new worker | Unverified until its provider registration/connect path is acknowledged |
| Codex fresh thread | Accepted dynamic-tool registration establishes advertised route support |
| Codex resumed thread | Keep unverified unless the current contract explicitly confirms the tool, or an authenticated tool invocation arrives |
| Claude / Pi / OpenCode / Gemini | Actual MCP `tools/list`, Pi extension startup acknowledgement, or tool invocation establishes connection evidence |
| Codex provider plans | Unverified until a valid `turn/plan/updated` is observed in this session; current adapter mapping alone is insufficient live evidence |
| Gemini provider plans | Unverified until a valid direct ACP plan arrives; the generic ACP schema alone is insufficient |
| OpenCode / Claude / Pi provider plans | Unsupported by the current structured-plan integration |
| Provider task projection | Unsupported by the current integration |
| App Todo editing | Unsupported by product policy: agent-managed list |

The existing unconditional `markTodoToolReady` in Codex startup must not certify a
pre-feature resumed thread. OpenCode accepting an MCP configuration is distinct from
the MCP server actually connecting. Prefer the existing authenticated readiness
notification over inferring readiness from a successful configuration write.

`supported + advertised` means the integrated route is connected/offered, **not**
that a model-generated operation has been verified. A successful authenticated tool
operation upgrades evidence to `observed`. Runtime UI wording is “Tool call observed”;
the release matrix separately establishes that a real model generated the call.
Failures return their normal tool error and do not invent a completed operation.

## Worker publication and generation

The supervisor is the single report owner for one execution. It already observes
provider handshakes, config updates, plan notifications, and Todo requests.

1. Carry wrapper runtime facts through session `_meta.providerRuntime`. For Gemini,
   use the real direct initialize reply plus launch-time executable metadata.
2. Establish `configGeneration = 0` from the initial effective configuration.
   Compare a stable list of `(option.id, option.type, option.currentValue)` sorted by
   ID. Identical catalog refreshes are not configuration changes.
3. After an acknowledged effective configuration/model/mode change, increment the
   generation. Clear model-sensitive observed plan/tool evidence. Retain advertised
   tool registration only when its actual contract is execution-scoped and still
   connected; otherwise Shared Todos stay unverified until registration is
   reconfirmed or a tool call succeeds in that generation. In either case old
   observed-call evidence cannot imply a call by the newly selected model. Static
   unsupported explanations remain valid.
4. Publish initial facts in session result `_meta.capabilities` and subsequent
   changes as `_still/capabilities_changed` with `params.capabilities`.
5. Add this notification to the existing replay allowlist and response-boundary
   journal flushing. Include the latest report in `sessionMetadata()` and
   `_still/caught_up`; a reconnect cannot depend on replaying an old event.
6. Rebuild only on semantic changes. Metadata publication must not add token-stream
   writes, transcript messages, conversation activity timestamps, or turn outcomes.

Keep report publication at the supervisor boundary. Provider runtime metadata in a
successful session reply is supplementary; the supervisor merges it with the
native-selected launch metadata and assigns the scope/generation. Early tool-ready
notifications may be retained until session identity exists. Do not publish a report
with a fabricated session ID. Duplicate config notifications and the matching
config-response acknowledgement must increment the generation only once.

Count only successful authenticated `_still/todos` requests as observed operations;
`_still/todo_tool_ready` and MCP `tools/list` are registration evidence. Old worker
protocol v3 peers ignore the optional report. No protocol-wide version bump is
required solely for adding capability metadata.

For a configuration change that happens inside the provider, an actual changed
`config_option_update` triggers the same invalidation. For Pi history revert that
changes the provider session ID, rescope the report and clear session-specific
evidence. Do not attach the old session's observation to the new provider branch.

Gemini's explicit initialize `agentCapabilities.loadSession` should be retained for
its existing native resume path when no session `_meta.resumable` is supplied. Apply
that fallback **only to direct Gemini ACP**, with a valid session ID. The wrapper's
hard-coded `loadSession: true` is not evidence for every native provider.

## Native validation and freshness

Validate once at the native wire boundary; use typed bounded data rather than
persisting arbitrary provider JSON.

- Report payload <= **16 KiB**. Retain exactly the four known feature keys, requiring
  all four; drop unknown feature/metadata keys before persistence. Unknown
  status/evidence/transport/schema version invalidates the report, not the agent
  conversation. Supported/unsupported claims require a recognized evidence value;
  unverified may omit it. `providerTaskProjection` and `clientTodoWrite`, which are
  fixed-unavailable in this slice, cannot be promoted by an incoming payload.
- Reason: 1–240 Unicode characters and <=960 UTF-8 bytes, without control characters.
  Version: <=200 characters / <=800 bytes. Executable and cwd: <=4096 UTF-8 bytes.
- IDs must match the native execution/provider session; cwd must equal the selected
  canonical snapshot cwd. The native host/account comes from the authenticated
  connection. Do not accept identity changes supplied by a capability report.
- Timestamps and generations are nonnegative JS-safe integers. Compare freshness
  using execution/generation/event ordering, not clock ordering across machines.
- A report from an older generation in the same execution is ignored. Invalid
  optional reports retain the last valid data as stale and produce one bounded
  notice per failure condition; they do not terminate a useful provider turn.
- Keep `capabilities` optional on the containing snapshot: old snapshots have no
  report. When present, the report requires its own `schemaVersion: 1`. Do not
  synthesize a “current” report from a static provider name.

| Lifecycle | Required behavior |
| --- | --- |
| Fresh session reply + validated report | Store current report after session identity is known |
| Disk/library restore | Retain report but mark stale, even if disk says current |
| SSH loss / stopped transport | Mark stale; preserve readable metadata |
| Attach handshake before catch-up | Keep stale while replay is incomplete |
| `_still/caught_up` with matching report | Replace with current worker facts |
| Catch-up from older worker with no report | Retain cached metadata as stale; explain unavailable evidence |
| New execution/provider resume | Start without current evidence; never inherit old execution support |
| Native user configuration request pending | Mark affected report stale until the response/current worker report arrives |
| Rejected configuration request | Retain old generation; restore current only if transport and matching report remain valid |
| Late old-attempt event | Ignore; cannot update the active conversation's report |

Use `Snapshot::history_header`, `agent_store::fields`, and the current append-only
journal. Checkpoint compaction must preserve the latest report and its scope. A
history Revert can trim messages while the current report stays associated with the
current execution/session. Add metadata events to `activeHistory`'s preserved event
types where needed. `conversation()` should keep ignoring metadata-only events.

## Discovery cache identity

Keep one logical host cache, but tag each result/in-flight request with the normalized
executable-override selection and connection generation (`transportId` at the UI
boundary). All `discoverAgents` callers are in `AgentWorkspace.tsx`: the automatic
effect and manual `check` action. Update both.

- A result for an older executable selection must not replace current selection
  data, even if that response finishes last.
- Existing localStorage records may display cached installation information, marked
  stale. They do not establish live feature support or readiness to prepare a new
  agent after executable selection changes.
- Dedupe identical requests. A newer selection must still schedule its own check.
- Preserve errors separately from previous readable values. Recheck on reconnect and
  after committing a changed executable selection; avoid launching checks per keystroke.

Keep the public hook small: add a selection key argument to `useAgentDiscovery`
and `discoverAgents` instead of a second global registry. Compute it from
`transportId` plus the normalized known-provider override map in stable AGENTS order.
At the settings field, trigger the changed-selection check on blur (or the existing
Refresh action), not each `onChange`. The selector must report a mismatch as stale
immediately so the prepared-agent effect cannot launch against old discovery data.
Automatic discovery also reruns on native connection replacement even if the
boolean connected state never went false.

## Acceptance IDs

| ID | Observable result |
| --- | --- |
| CAP-AC1 | Discovery reports real selected executable/version/transport or an explicit unknown; version failure does not break launch |
| CAP-AC2 | Host/executable response races cannot overwrite current discovery selection |
| CAP-AC3 | Advertised vs observed Todo evidence differs; resumed Codex and unconnected OpenCode cannot get false proof |
| CAP-AC4 | Same config refresh keeps generation; changed effective config invalidates model-sensitive evidence |
| CAP-AC5 | Restore/disconnect are stale; matching catch-up becomes current; legacy catch-up remains honest |
| CAP-AC6 | Wrong scope, malformed fields, oversized data, and old-generation reports never become current |
| CAP-AC7 | Native journal, checkpoint, resume, and renderer reconciliation preserve the correct report |
| CAP-AC8 | Gemini retains explicit resume advertisement without claiming a successful blocked session |
| CAP-AC9 | Capability updates change no messages, drafts, task contents, turn status, or activity ordering |

Verification mapping and exact commands: [VERIFICATION.md](VERIFICATION.md).
