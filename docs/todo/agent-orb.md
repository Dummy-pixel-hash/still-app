# AG-01 — Agent-driven orb

Updated: **2026-10-30**. Status: **DEFERRED — user requested capability work first**.
This is the originally planned first feature milestone in the
[Agents tracker](README.md). It documents the approved signal-source change and a
proposed implementation; the runtime is still connection-driven today.

## Product decision

**Keep the existing orb. Drive it from the Agents workspace's structured conversation
state. Clicking it opens the relevant agent conversation.**

“From the agent window” means the same underlying state used by Agents, including
conversations running in the background. Rendering a conversation is not a condition
for observing it. Terminal bytes, terminal silence, and tmux/SSH-terminal card state
are removed from orb classification when this milestone ships.

The approved smoked-glass material, sizes, pause/speed settings, keyboard controls,
native placement, and opt-in companion remain the existing foundation. Agent settings
will provide access to these same preferences.

## Current implementation and required changes

| Area | Current behavior | Required change |
| --- | --- | --- |
| `src/orb/useOrbPublisher.ts` | Builds inputs from terminal sessions, connection state, and auth/host-key prompts | Read managed agent conversation status and agent-scoped connection blockers |
| `src/orb/publisher.ts` | Subscribes to terminal data and stores recent-output timestamps | Publish semantic status changes; preserve coalescing, heartbeat, error/retry, and disposal |
| `src/orb/types.ts`, `state.ts` | `sessionId`, connection signals, and 8-second output activity | Conversation IDs, agent signals, observation state, and unread attention |
| `src/orb/useOrbView.ts` | Expires output activity and publisher freshness | Expire publisher freshness without guessing agent activity from time since output |
| `src-tauri/src/orb.rs` | Validates connection rows, ranks sessions, builds native session menu | Validate the new contract and mirror agent ranking/menu/action semantics |
| `src/screens/Workspace.tsx` | Orb activation opens a terminal card | Route to Agents and the selected durable conversation ID |
| `src/components/RemoteAgentWorkspace.tsx`, `AgentWorkspace.tsx` | Selection/recovery mostly live in the mounted Agents surface | Accept conversation activation and share ongoing observation outside the visible surface |
| `src/session/agentThreads.ts` | Stores events and requests; saved rows begin unverified | Provide a small shared status projection with durable terminal outcomes/read markers |
| `src-tauri/src/agent.rs` | `threadComplete` stores `stopReason` as display text; multiple outcomes share `complete` | Preserve typed outcome/operation identity so finished, stopped, refused, and limited differ |

The existing `working` state also means “ready for another prompt” when
`turnActive` is false. `threadStopped` is a cancellation request awaiting confirmation.
Neither field alone is a reliable green/blue signal.

## Signal source and ownership

```text
provider's structured events and worker acknowledgements
    → existing agent adapter / persistent supervisor
    → native agent journal and snapshots
    → shared agent conversation store and semantic status projection
         → Agents header/sidebar/inbox
         → main-window orb publisher
              → native retained metadata snapshot
              → isolated OrbScreen and native conversation menu
```

- The native worker/agent integration remains the execution authority. The main
  application owns observation and publication; the isolated orb subscribes to
  metadata and emits navigation/preferences actions.
- Mount the observer once at the main-app lifetime boundary. Reuse the current
  module-level agent subscriptions and connection ownership instead of spawning a
  second provider or controller.
- Move the minimal reattachment/reconciliation work needed for already-monitored
  conversations out of visibility-dependent effects. Closing Agents or opening a
  different project must not stop observation.
- On an already-authorized connected host, catch up known monitored executions using
  the existing SSH connection. After transport loss, preserve existing credential
  and host-key policy. Enabling the orb is not permission to connect every saved host.
- After an app restart, load local history as last-known/unverified. Reattach known
  executions after a deliberate host connection or permitted recovery, then mark
  their live status current only after catch-up. An unavailable worker produces an
  inspectable recovery state rather than silently starting a new task.
- The current supervisor has a single controlling attachment. The orb must consume
  the existing main-app store rather than attach independently and replace that owner.

## Conversation scope and identity

- Track all known real conversations with live activity, unresolved attention, or an
  unread result, across projects and providers. Include ready connected conversations
  in the menu. Quiet archived/saved history belongs in the library rather than filling
  the companion menu.
- Include an archived conversation while it is running, blocked, or has an unread
  result. Archiving is an organization action, not a stop/acknowledgement operation.
- Exclude unused pre-message preparations and draft-only launches. Their errors stay
  in the launch UI; they do not become fictitious running conversations.
- Use the durable **conversation ID** (`row.meta.id` / persisted `conversationId`)
  for activation and read state. Resolve its current execution at action time.
- Use **execution ID** plus a stable source event/request/turn identity for ordering
  and duplicate suppression. Prefer the worker's durable journal cursor where
  available; a snapshot's new local publication revision is not a new agent event.
- A provider resume may replace execution ID while preserving conversation ID.
  Old menu actions must still open the right conversation. Deleted/tombstoned targets
  fall back to Agents with a concise unavailable-conversation notice.

## Status contract

This table defines user-facing meaning. Add typed outcome/observation fields where
the existing event/snapshot contract cannot express it; avoid parsing transcript prose.

| Authoritative fact | Label | Existing visual state | Clearing condition |
| --- | --- | --- | --- |
| Current pending provider permission | Approval needed | `needs-input` / amber | Confirmed response/cancellation or reconciled removal of that request |
| Current pending provider question | Answer needed | `needs-input` / amber | Confirmed response/cancellation or reconciled removal of that request |
| Credentials/host identity block this agent conversation | Sign-in required / Review server identity | `needs-input` / amber; changed identity is an error | The agent's connection flow resolves it |
| Prompt/response/history operation has unknown delivery | Check operation outcome | `error` / red | Authoritative reconciliation; viewing alone cannot unblock sends |
| Provider/worker reports failure | Agent failed | `error` / red | Seen result lowers prominence; retry/recovery determines execution state |
| A normal user turn ends with confirmed `end_turn` | Turn finished | `done` / green while unread | Viewing/marking the result read, or a newer turn taking over |
| Provider confirms cancellation | Stopped | Neutral `idle` | A newer turn or library read state; never a green success |
| Turn ends with refusal or a provider turn/token limit | Request refused / Limit reached | `needs-input` / amber while unread | Viewing acknowledges the result; continuing requires an explicit supported action |
| A confirmed/current turn is active with no blocking request | Working | `working` / blue-violet | A semantic request, terminal outcome, or loss of observation |
| Cancellation requested, not yet acknowledged | Stopping | `working` | Confirmed cancellation, failure, or unknown outcome |
| History mutation in progress | Reverting conversation | `working` | Acknowledged mutation or recovery-needed outcome |
| Connecting or replaying a known execution | Connecting / Catching up | Neutral `unknown` | Confirmed current snapshot after catch-up |
| Remote observation is lost | Disconnected · status unknown | Neutral `unknown` | Successful reattachment/catch-up |
| Ready conversation with no active turn or unread result | Ready | Neutral `idle` | A new operation/event |
| Only saved history is known | Saved · live status unknown | Neutral `unknown` | Deliberate connection and authoritative reconciliation |
| No eligible conversations | No active agents | Neutral `idle` | Eligible conversation appears |
| Main publisher is stale or unavailable | Status unavailable | Neutral `unknown` | Fresh valid publication |

**Turn finished means the agent finished responding.** It does not establish that
the code is correct, tests passed, or the user's entire project is complete. Internal
refresh/compaction/configuration operations do not create a new successful-task alert.

With [AG-18 conversation todos](agents-roadmap.md#ag-18-conversation-todos-and-task-progress),
task counts describe checklist progress in Agents. Checking the last item cannot
finish a running turn or clear a request/error in the orb. A confirmed finished turn
may still have open todos. The initial orb can ship independently of the task view;
this same status contract applies when todo tracking is added.

An approval-response acknowledgement establishes that the choice was forwarded;
it does not establish successful execution of the permitted operation. A stale
pending request may remain in history but must not be shown as a currently actionable
approval until it has been reconciled.

### Aggregation and unread behavior

Rank eligible conversations in this order:

1. Unresolved questions/permissions/access blockers and unknown-operation recovery.
2. Unread failures, refusals, or limit outcomes.
3. Unread normal turn completions.
4. Currently working/stopping/reverting conversations.
5. Connecting, detached, or otherwise unknown observations.
6. Ready conversations.

Use oldest unresolved attention first within the first tier to prevent starvation;
use newest semantic result within later result tiers, with conversation ID as a
deterministic tie-breaker. Streaming text must not reorder the list. Seen failures
remain visible in their conversation/inbox but stop permanently dominating the orb.

Keep one row per conversation. Store per-conversation read markers referencing
durable event identities in native metadata. A background render, hover, menu open,
or notification delivery does not mark a result read. Mark read when the relevant
result is visible in focused Agents or through an explicit action. Pending requests
stay pending even after they are seen.

Use the same projection and read markers for AG-05's inbox and notifications. Replayed
results may become unread if they occurred after the saved cursor, but must not
produce duplicate alerts. Freshly imported historical sessions start as history,
not a batch of new completions.

## Freshness and background lifecycle

- Preserve the current **4-second publisher heartbeat** and **15-second stale
  publisher threshold**, independent of animation frames and orb motion settings.
- Publisher freshness and remote observation are separate. A heartbeat only proves
  the main application is publishing. It must not make a detached worker look live.
- A healthy attached turn stays Working through long silent tools/provider waits.
  Remove the terminal-output 8-second activity heuristic from this path.
- Preserve last-known remote facts while marking current observation unknown after
  transport loss. Clear stale request actions until catch-up verifies them. Retain
  the historical event/read record for the inbox.
- Publish semantic changes promptly and coalesce bursts. Do not serialize transcripts
  or update the native menu for every token. Reduced motion and hidden/minimized UI
  affect rendering, not observation or heartbeat.
- Hiding the orb only hides the companion. Closing Agents preserves active execution
  and observation. Exiting Still closes its windows; remote workers can continue,
  with new status available after the next successful catch-up.

## Native metadata and navigation contract

Update TypeScript, the native adapter, Rust validation, browser simulation, and tests
together. The current Rust enums and `deny_unknown_fields` require a coordinated
contract change; terminal IDs must never be interpreted as conversation IDs.

Proposed metadata contract:

| Field | Purpose |
| --- | --- |
| Snapshot schema version, revision, published time | Migration, stale detection, and out-of-order snapshot rejection |
| Existing orb preferences | Reuse persisted enabled/size/motion/speed settings |
| Durable conversation ID | Navigation target resolved by the main app |
| Current execution/event identity where needed | Deduplication and stale-action detection |
| Bounded title, provider label, optional project display label | Recognizable menu rows |
| Normalized signal and observation state | Truthful label, icon, material, and urgency |
| Semantic changed time and unread/attention marker | Stable ordering and acknowledgement |

Publish only the required metadata. Exclude transcript bodies, tool arguments,
approval schemas/answers, raw errors, credentials, and SSH connection arguments.
Titles follow the app's bounded display-name policy; they are not a separate copy of
prompt or tool content. Keep the existing 64-row snapshot bound and first-12 menu
limit, with **More conversations in Agents…** leading to the full inbox.

Both native menu ordering and renderer summary must implement the same contract.
Validate identifiers, enums, lengths, timestamps, duplicate rows, and caller identity
at the native boundary. Ignore old/unsupported snapshots safely. Preserve existing
position and appearance preferences during the status-source migration.

### Activation

1. Native click/menu/keyboard action brings Still forward only because the user acted.
2. Resolve a validated durable conversation ID in the main app; open Agents, select
   its saved project/provider, and reveal the relevant request/result.
3. If Agents is still loading, retain a single pending navigation intent until its
   library is ready. Consume it only after selection succeeds; handle a deleted target.
4. Preserve an existing modal's focus and unsent responses/drafts. Apply pending
   navigation after the modal is resolved rather than replacing its callback/owner.
5. Normal explicit conversation-selection rules govern connection and reattachment.
   The orb cannot approve a request, send a prompt, or create an execution itself.
6. With no eligible target, open the Agents library/inbox. Right-click exposes
   conversations, Open Agents, pause, placement reset, and hide.

Add a scoped conversation-activation input to `RemoteAgentWorkspace`/`AgentWorkspace`
instead of assuming a terminal `Session` identifies the desired chat. An orb action
must work with no terminal cards, renamed conversations, collapsed navigation, and
multiple conversations on the same server.

## Implementation checklist

- [ ] **AG-01a — Semantic outcome audit.** With AG-11a, trace each provider's normal
  turn, cancellation, refusal/limit, question/permission, maintenance, and failure
  events. Persist typed outcome/operation/source identities in the native event and
  snapshot contract. Verify legacy history becomes unverified where facts are missing.
- [ ] **AG-01b — Shared projection and read state.** Build the smallest agent-status
  projection beside the existing store; persist seen event identities using native
  metadata. Use it for Agents labels and the orb. Include current/unknown observation
  and semantic subscriptions independent of animation frames.
- [ ] **AG-01c — Background lifecycle.** Lift only necessary observation/recovery
  ownership to the main-app lifetime; reuse attached streams, avoid duplicate
  provider/SSH owners, and catch up monitored conversations on authorized hosts.
- [ ] **AG-01d — Publisher and native contract.** Replace terminal-data input with
  the agent projection; migrate Rust/TypeScript rows, sorting, menus, snapshots, and
  stale behavior as one versioned change. Preserve existing publication safeguards.
- [ ] **AG-01e — Conversation activation and preferences.** Wire native/browser
  actions to Agents by conversation ID, handle hydration/modals/deletion/resume,
  update accessible/menu labels, and expose the shared orb settings inside Agents.
- [ ] **AG-01f — Verification and current docs.** Complete the matrix below; update
  `ORB.md`, `PRODUCT.md`, `DESIGN.md`, and README runtime descriptions when shipped.
  Record provider/platform evidence and then mark AG-01 DONE in the master tracker.

## Acceptance and verification matrix

| Scenario | Required result |
| --- | --- |
| No terminal cards; agent conversation starts | Orb follows the agent and opens its conversation |
| Unrelated SSH terminal emits output or disconnects | Agent orb state does not change |
| Turn runs a long quiet command | Working persists while observation is healthy |
| `working` snapshot with `turnActive: false` | Ready, not an active-work indicator |
| Question/permission in an unfocused conversation | Attention outranks running work; click reveals that exact request |
| Approval forwarded, tool still running | Return to Working; no green completion |
| Cancel requested, acknowledgement delayed | Stopping until the provider confirms the outcome |
| Normal end, refusal, limit, cancellation, maintenance | Distinct labels; only a normal user-turn result can create green unread completion |
| Seen result versus unresolved request | Seen result clears its unread emphasis; pending request stays actionable |
| Multiple hosts/projects and archived active work | Correct aggregation with no dependence on selected conversation |
| Closing Agents, opening terminal/settings, minimizing Still | Agent observation and publisher heartbeat continue |
| SSH loss with outstanding work/request | Current observation becomes unknown; historical facts are retained |
| Reattach and replay, including older snapshots | Same execution recovered; no duplicate prompts, requests, or result alerts |
| App restart with saved history | Unknown/last-known until catch-up; saved read state is preserved |
| Resume changes execution ID; conversation renamed | Old valid conversation activation still finds the correct conversation |
| Menu target deleted or modal open | Safe Agents fallback or deferred navigation; no discarded draft/modal |
| Pause/reduced motion/hidden companion | Material behavior changes; observation and agent execution continue |
| Publisher stale, invalid payload, unsupported schema | Neutral unknown; bounded validation and actionable retry |
| More than 64 eligible conversations | Highest-priority bounded rows; full list remains reachable in Agents |

Extend existing `tests-orb` state/publisher/subscription tests, native `orb.rs` tests,
and the `tests-agents` fixture around these scenarios. Exercise the real root
application route as well as isolated fixtures so lifecycle/navigation wiring is
covered. Native validation and frontend examples should share equivalent status
cases to prevent menu/orb disagreement.

Relevant checks when implementing:

```sh
npm run typecheck
npm run test:orb
npm run test:agents
npm run test:terminal
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Run targeted terminal tests for the removed orb coupling and retain the existing
native companion lifecycle checks. Verify actual provider events for every adapter
whose mapping changes. On packaged Windows, check minimized publication, focus/modal
preservation, click versus drag, menus, display placement, and closing both windows.
Browser fixtures alone do not establish native/SSH correctness.

## Completion record

Implementation reference, automated results, provider versions, and Windows/native
evidence will be recorded here when AG-01 is delivered. No implementation checklist
item has been completed by writing this specification.
