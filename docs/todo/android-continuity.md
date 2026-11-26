# Desktop ↔ Android continuity

Updated: **2026-11-16**. Status: **shared catalog/organization, native intent recovery,
server-owned child coordination and opt-in alert outbox implemented; full native
continuity release and FCM delivery are not signed off**.

This is the focused execution plan for MOB-02–04 and the sync-related portions of
MOB-06–13. The product scope lives in [Android phone application](android-mobile.md);
implementation status lives in [the Android task list](android-mobile-tasks.md).
The checkpoint below distinguishes implemented behavior from the full target
contract. Later payloads and module boundaries remain proposals unless noted.

## Implementation checkpoint

Implemented for newly created protocol-v4 remote workers:

- Verified-SSH discovery imports remote conversation/execution identities into the
  native library, including an initially empty device library. It creates neither
  a provider session nor a replacement worker during enumeration.
- Desktop and mobile attach as concurrent subscribers. Accepted prompts, streamed
  output, requests and outcomes replay into the same conversation; another client
  is not disconnected just because a device opens it.
- The worker serializes prompts, answers, configuration changes and cancellation.
  Shared prompts have durable receipts, native uncertain-send intent and receipt
  reconciliation. Requests/configuration/cancellation carry observed-state fences.
- Local drafts survive discovery, catch-up and rejected competing submissions.
  Native shared-frame cache failures stop catch-up; a rejected shutdown continues
  projecting shared events instead of dropping them.
- Legacy executions can be discovered, but an imported v3 worker is not silently
  taken over. Revert/retry are disabled for shared workers until shared-history
  mutation semantics are implemented.

Verification covers Node worker/store tests, native Rust tests, mobile browser
fixtures, and an explicit native verified-SSH integration test using a temporary
ACP peer. The peer is **not a real model**. The native test verifies bidirectional
messages, unchanged provider-session identity and a close-versus-send race.
Browser fixtures do not establish Android/native interoperability.

### Software continuation — 2026-11-13

The unfinished work from OpenCode session `ses_e4b301631ffeni4T7CJptSL0gJ`
("Agent Interface Mock Preview Iteration") was continued in the existing worktree:

- `shared-library.mjs` owns an account-private durable catalog. Atomic replacement,
  file/directory fsync, owner/permission checks and a kernel `flock` serialize
  independent SSH processes. A crashed process cannot leave a guessed-PID writer
  lease. This requires Node.js 20+ and the server's `util-linux`/`flock` utility.
- Projects and live/ended conversation identities remain in the catalog after
  worker discovery disappears. Discovery is still non-destructive and may ingest
  existing validated worker records; it never launches or replaces a provider.
- Conversation title/pin/archive/manual order use field revisions; project
  names/order use revision-aware account transactions. Read watermarks merge with
  `max` and cannot advance past observed history. Project/conversation removals are
  catalog tombstones, not remote filesystem deletion. A non-empty project removal
  is rejected rather than queued for a future destructive surprise.
- Native metadata projection preserves drafts, attachment selections and originals.
  Existing local organization is held for explicit adoption instead of overwritten.
  Conversation and project mutation identities are cached durably before SSH;
  lost replies retry the same identity, conflicts retain the intended change and
  require review, and project intents reconcile after a later successful sync.
- Explicit verified same-provider recovery can advance one execution generation,
  retaining history, organization and the read offset. Live/uncertain local work is
  not silently replaced. This is not a general importer for arbitrary legacy history.
- Foreground account discovery continues after navigating away or hiding the sync
  panel. Removing a saved account stops its local watcher/SSH connection; it does
  not stop remote jobs. Closed apps do not depend on background SSH polling.
- `subagents.mjs` moves parent tool dispatch, dependent setting selection, durable
  child identities and guidance queues to the remote worker. It supports discovery
  of human-created children, holds old-generation guidance after a resume, fences
  cancellation to its observed prompt, and stops an old coordinator before ownership
  is retired. Human/model workers share a serialized three-active-child boundary.
  New server-coordinated parents require `prepare` before paid `spawn` so the caller
  knows a stable child identity before a possible lost acknowledgement.
- Fixed an actual tool bridge bug: `prepare` was advertised in the subagent schema
  but rejected by the common request helper. Fixed the promoted first-message draft
  not being cleared after acknowledgement; changed-in-flight drafts are retained.
- The opt-in durable notification outbox retains only opaque routing facts. A
  private configured HTTPS relay receives bounded retries with stable event IDs.
  Relay acceptance is recorded separately from phone receipt or provider outcome.
  Answering elsewhere/reading suppresses unsent obsolete alerts. No relay is
  configured or contacted by default; see the deployment contract below.

**Deliberately not claimed complete:** verified LAN/VPN endpoint-alias adoption;
complete old-device transcript/provenance export/import and safe live-v3 transition;
an account-wide canonical-history/subscription broker (current foreground catalog
refresh is periodic and transcripts remain worker-owned); deployed relay/device
registration and native FCM token/receiver/cold-start routing; clearing an alert
already accepted by a relay; real-model/native desktop/phone acceptance and the
remaining daily-use Android checks. These require further work/evidence, not
checking off the whole mobile roadmap. ADB became available on 2026-11-14 for the
APK installation below; the complete two-device acceptance journey remains open.

### Device follow-up — 2026-11-14

- Reproduced the exact native metadata rejection across the real Node catalog
  producer and Rust storage projection. Filesystem `mtimeMs` may be fractional;
  native conversation order requires an integer. New timestamps and old catalog/
  receipt responses now use whole milliseconds without rewriting old organization,
  receipt IDs, field revisions or device drafts.
- Discovery refreshes provider-session/resume evidence for an existing execution
  instead of retaining the initial unconfirmed cache forever. A changed provider
  session/account is rejected, not adopted. Direct Gemini discovery honors its
  advertised `loadSession` capability; wrappers still require their own confirmation.
- Imported older desktop conversations no longer attempt their destructive legacy
  attach path. **Upgrade saved session** is an explicit action for a confirmed saved
  provider session, using the existing verified-dead-process recovery guard. It
  resumes that session under protocol v4 without replaying a prompt. Legacy workers
  predating Todo storage can pass read-only preflight without manufacturing a store.
- If resume support is unconfirmed, **Refresh saved session** retries discovery
  instead of instructing the user to abandon the conversation. Live or uncertain old
  executions remain protected: the app does not stop a desktop worker to force an
  upgrade. Full old-device transcript/provenance transfer is still separate work.
- Built and installed the updated optimized ARM64 APK on the A142 over ADB. It uses
  the phone's existing development signer, version `0.1.1` / code `1001`, preserving
  both app-data directory identities. This is a local validation build, not a
  production signing migration or published release.
- Verification: **197 Node tests**, **93 Rust tests** (3 ignored), **8 recovery UI
  tests** and **17 mobile browser tests** passed. A temporary ACP peer proves a
  protocol-v3-to-v4 upgrade retains the provider session/Todos and sends no prompt.
  The user subsequently confirmed that a real Home-Work saved session resumed;
  the refresh/title problems reported afterward are addressed below. This is not
  a sign-off of the complete two-device acceptance journey.

### Post-resume discovery and titles — 2026-11-14

- Inspected the three reported invalid execution records. They are protocol-v1
  records without conversation, project or provider identity. They remain on the
  server; discovery does not invent a mapping or delete their history.
- A successful sync now returns skipped-record diagnostics separately from hard
  failures. Unrelated old records no longer turn a successful provider resume into
  "library refresh needs retry". Account changes, unsafe account storage and failed
  catch-up remain failures. Mobile partial-sync diagnostics use a status, not an alert.
- Older valid workers often stored chat titles only in durable
  `_still/chat_title_changed` journal events, not `state.json`. Discovery now indexes
  those events incrementally (8 MiB per execution per pass, 4 KiB candidate-record
  buffer). Only title/progress metadata enters the catalog; transcripts and originals
  are not rewritten, and no provider/model is started to generate a name.
- A verified recovery lineage can supply a resumed conversation's missing original
  title. Explicit user renames still win. An empty unindexed catalog title cannot
  erase a known device title; an imported conversation without any recorded title
  is honestly labelled **Saved**, not **New**.
- A read-only projection over the local server's existing files recovered 11 titles
  from safely identifiable legacy workers. Records missing their identity remain
  skipped rather than guessed. This is title recovery, not full legacy transcript
  or provenance migration.
- Verification: **208 Node tests**, **94 Rust tests** (3 ignored), **18 mobile browser
  tests**, and the **8 targeted recovery UI tests** passed. Regression coverage
  includes incomplete UTF-8 appends, large journal frames, symlinks, user title
  overrides, resumed generations, partial-sync status and cached-title preservation.

### Legacy-only sync notices — 2026-11-14

The reported "77 records skipped or need review" message mixed historical metadata
limitations with actionable warnings and repeated raw execution IDs above the chat.
Discovery now returns identifiable-but-incomplete old records as structured
`legacyRecords`, separate from warnings. Successful sync shows **Conversations
synced.**, with the old-record count and explanation in optional, collapsed details.
The same component is shared by the phone library and compact conversation view;
real account/network failures remain visible alerts and unsafe/mismatched records
still have separate review warnings. Reopening a status panel immediately reuses its
latest result instead of waiting for another poll.

This is **not** migration or deletion of those old records. Missing identity facts
are not guessed. The shared-project deletion guard still refuses to infer that a
project is empty while unscoped historical records exist. Regression coverage
includes 77 collapsed records, keyboard expansion and scroll access, fatal-error
visibility, warning/legacy separation and paginated diagnostic deduplication.
Validation: **213 Node tests**, **94 Rust tests** (3 ignored), **19 mobile browser
tests** and **8 targeted recovery UI tests** passed.

### Windows legacy-library export checkpoint — 2026-11-16

The user confirmed that the original chats and message history remain visible in
the **Windows desktop app**. A read-only Windows exporter was implemented as a
fallback for its original logical IDs/device-owned metadata. It must **not** be
treated as the primary or required path for synchronizing Linux-server conversations:
missing fields in Still's worker descriptors do not establish that the provider's
own Linux history is absent. The subsequent server-store audit below corrects that
earlier assumption.

Implemented a standalone, dependency-free Node.js export in
`scripts/migration/export-windows-library.mjs`; usage and the remaining receiving
contract are in [Windows library recovery](../windows-library-recovery.md).
The inventory is read-only, uses stable account selectors, and does not start an
agent. Explicit export creates owner-private, checksummed local journal backups
and an account-scoped portable file. Drafts, saved credentials, attachment files,
raw action/request payloads and current capabilities are omitted from the portable
file. Historical text is opt-in and still private. Exact old execution references
are retained without inventing missing provider identities or cross-account merges.

This checkpoint is **export-tool implementation**, not completed migration. The
tool still needs to run on the Windows profile containing the actual history.
No Windows export has been received, no server catalog/history import has been
performed, and the skipped historical records are not claimed recovered. An older
WebView-only cache, if encountered instead of native journals, needs a different
read-only extraction path; it must not be cleared or guessed from LevelDB strings.

### Linux-provider source audit — 2026-11-16

The user clarified that synchronization must originate from the **Linux server**,
not a manual Windows export. Normal operation needs no Windows PowerShell step.

- Examined only provider sessions referenced by the 71 incomplete Still worker
  descriptors; unrelated provider/harness conversations were not selected for recovery.
- Created an owner-private, consistent SQLite backup before external inspection of
  OpenCode storage. The live provider database was not edited, migrated, deleted or
  restarted. No model prompt, new provider session or background service was started.
- The 42 legacy OpenCode worker references point to **36 distinct provider session
  records** on Linux. All 36 retain their project directories; **17** have recorded
  titles and saved user/assistant history. The private snapshot contains **223 user
  message records and 5,315 assistant records** for those legacy sessions. These are
  provider message/step records, not a count of separate Still conversations.
- Found **14 unique referenced Pi session files** on Linux with session headers,
  original project directories and saved history (**143 user message records and
  2,315 assistant records**). Fifteen other legacy Pi references did not resolve at
  their recorded file paths; relocation/deletion has not yet been established.

This is **verified source availability, not completed phone synchronization**. The
next implementation must read provider-owned history into a scoped, paginated
server history/catalog path, preserve provider IDs/provenance and existing Still
aliases/tombstones, and never treat historical requests as live approvals or replay
prompts. Existing/live v4 workers must not be replaced or given duplicate history.
Windows extraction is only an optional fallback for genuinely device-only data or
provider records unavailable on Linux; it is not required to read the histories
already verified on this server.

### Opt-in relay handoff contract

On the selected remote account, the operator may provision
`~/.local/state/still/catalog-v1/notification-relay.json` with mode **0600** in the
private catalog directory. It contains `enabled`, a user-owned **HTTPS** `url`, and
a scoped `token` of at least 32 characters. Do not put real values in this repository
or chat. Provisioning a relay, an FCM project or credentials has not been done.

The sender posts JSON with `eventId`, `kind` (`needsInput`, `result`, `failure`),
account/conversation/execution IDs, generation, source sequence, optional opaque
request key, and expiry. It uses a Bearer header, refuses redirects, and requires a
successful JSON acknowledgement containing the same `eventId`. The relay must
deduplicate those IDs because network acknowledgement loss permits at-least-once
delivery. Payloads contain no transcript, question/schema, permission arguments,
SSH address, attachment URL or credential. Delivery is disabled without this file.

The detached account sender uses a separate kernel lock, short per-event catalog
leases, 15-second network deadlines, bounded exponential retry and 24-hour expiry.
No phone token/receiver has been registered: this is a tested server-to-relay
handoff implementation, **not** evidence that a locked phone receives FCM.

### Verification and build evidence (2026-11-11)

- `npm run build`: passed.
- `node --import ./tests-agents/isolated-env.mjs --test tests-agents/*.test.mjs`:
  **159 passed**, including **52** focused bootstrap/discovery/continuity/worker tests.
- `cargo test --lib --no-default-features`: **88 passed, 3 ignored**.
- The ignored `native_continuity_discovers_and_replays_another_clients_worker_over_verified_ssh`
  test was run explicitly under Xvfb with `STILL_KNOWN_HOSTS` pointing to the
  localhost fixture's pinned host key: **passed**. This uses the temporary ACP peer.
- `npx playwright test -c tests-mobile/playwright.config.ts`: **17 passed**,
  including empty-library discovery, answering/sending on the discovered execution,
  and keeping a rejected phone draft through navigation.
- The wider 226-test desktop agent UI run is **not a clean pass**: it was stopped
  at the 120-second command limit after two accessibility tests timed out looking
  for `Toggle projects`; the remaining suite has not been validated in this pass.
- Fresh ARM64 Android debug APK built at
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
  APK inspection confirms `dev.still.app.MainActivity` and `arm64-v8a`.
- Fresh Linux debug application built at `src-tauri/target/debug/still-app`.
  It remained running in an isolated-data Xvfb launch until the 8-second smoke
  timeout; this does not establish interactive desktop/phone acceptance.

The previously installed A142 APK predates this implementation. The new APK above
has **not been installed**: ADB still lists no device. Reconnect the phone before
running the physical desktop/phone acceptance journey.

## 1. Product decisions confirmed with the user

| Decision | Selected behavior |
| --- | --- |
| Acting on a conversation | **Act from either device.** Opening, sending, answering, and stopping do not require a device takeover step. The server orders competing actions. |
| Shared organization | **Sync organization too:** projects, conversation titles, pins, archives, and read/unread state, alongside history, requests, Todos, and remote terminal identities. |
| Local state | Unsent messages/answers, local attachment selections, reading position, and device appearance remain on that device initially. |
| Alerts | **User-hosted relay first**, with FCM delivery to Android. Conversation data and execution remain on the remote server. |

The existing Android-first, remote-server scope still applies. A laptop can be
powered off while the phone uses work running on an independently available
server. Desktop-local work needs that machine to act as an available host; it is
not part of this first continuity release.

### Central acceptance journey

1. Start a remote task from the desktop application.
2. Open Still on a freshly configured phone. The same task is discoverable without
   manually entering its execution ID or starting another provider session.
3. Both devices see the same submitted prompt, response, activity, Todos, and request.
4. Answer on the phone. The desktop sees the accepted answer and resumed work.
5. Put the laptop offline. The phone can send the next message to that conversation.
6. Reopen the laptop. It catches up, including phone messages and organization edits.
7. With both apps disconnected, the server can still produce a needs-input alert;
   tapping it on the locked phone opens the current request after catch-up.

These checks require real native clients and a real provider. The APK installed on
the A142 in this conversation establishes installation/startup, not this journey.

## 2. Pre-continuity baseline (historical, not the current checkpoint)

This table records the starting gaps before S1/S2 and the software continuation
above. Do not treat its replace-owner/local-only descriptions as current behavior.

| Foundation | Gap to close | Entry point |
| --- | --- | --- |
| Android shell, native bridge, local thread cache | Home loads the device library; it has no remote account discovery/sync service | `src/mobile/MobileApp.tsx`, `src/session/agentThreads.ts:loadAgentThreads` |
| Durable local conversation journals | Native history is explicitly device-owned. Local sequence numbers and whole metadata objects are not a cross-device merge contract | `src-tauri/src/agent_store.rs`, `src/session/agentStorage.ts` |
| Persistent remote worker and provider process | `_still/attach` replaces the previous owner; published events go to that owner only | `src-tauri/agent-host/supervisor.mjs:handle`, `publish` |
| Worker event journal and replay cursor | Replay is execution-scoped; it is not a catalog of live and ended conversations. Submitted user text is emitted by the native client before sending; worker prompt receipts store identities, not a complete shared transcript | `supervisor.mjs:replay`, `still_agent_send` in `src-tauri/src/agent.rs` |
| Prompt duplicate guard and request acknowledgement | Need durable cross-device receipts for every mutation and deterministic races. Provider delivery can still be uncertain | `supervisor.mjs`, `src-tauri/src/agent.rs` |
| Stable local conversation IDs and tmux names | Account identity still keys off endpoint strings. A LAN address and VPN alias can produce different local projects; terminal discovery is device-local | `src/session/identity.ts`, `src/agents/workspace.ts`, `src/types/index.ts` |
| Parent/child task UI and worker tool forwarding | Delegation handling and queued guidance currently execute in the mounted workspace. The worker refuses a subagent request without an attached parent client | `src/components/AgentWorkspace.tsx`, `supervisor.mjs:requestSubagents` |
| Native Android Activity and credential adapter | IME/Back integration exists; device-lifecycle, real SSH/request flow, and upgrade evidence must be completed | `src-tauri/android/MainActivity.kt`, `scripts/android/smoke.mjs` |
| Mobile notification settings copy | No production registration, FCM receiver, or remote notification outbox is established | `src/mobile/MobileApp.tsx`, Android build sources |

`agentCatalog()` currently means **provider commands/configuration discovery**. It
must remain distinct from the new remote conversation catalog.

## 3. Recommended architecture

```text
Desktop native client ── verified SSH ──┐
                                     ├── Still account hub (remote Unix account)
Android native client ── verified SSH ─┘      ├── conversation/project catalog
       │                                    ├── ordered history + command receipts
       └── private local cache/drafts        ├── shared organization/read state
                                            └── persistent execution workers
                                                  └── provider sessions
                                             │
                                      durable alert outbox
                                             │ outbound HTTPS
                                 user-hosted notification relay ── FCM ── phone
```

### Responsibilities

- **One account hub per remote Unix account.** A small Node.js service owns the
  catalog, shared metadata, durable command acceptance, and subscriber fan-out.
  Start/connect over the existing SSH bootstrap; bind a private Unix socket.
- **Existing workers own provider processes.** Extend their protocol instead of
  launching agents inside a client or putting a provider process inside an HTTP
  request. A transport drop leaves execution running.
- **Both clients use the same native sync contract.** Rust persists cache and
  outgoing operation identities; React observes projections and sends commands.
  The selected screen does not own the sync connection or server process.
- **The relay only delivers alerts.** Losing it delays alerts while authenticated
  SSH use, history, and provider work continue independently.

For each configured account, native clients keep one foreground library subscription
and open bounded history streams for the selected conversations. Account-wide
summaries update the home/Needs you list without loading every transcript or opening
one connection per row. Android resumes/catches up on foreground; remote push owns
locked-phone alerts when no native client stream is alive.

Keep Node.js 20 compatibility in the first implementation. Use the existing
private-journal/atomic-file primitives: one durable commit record can contain a
receipt, event, and metadata change together. Checkpoints/catalog indexes are
rebuildable projections. Serialize commits through one verified hub instance,
with bounded journal segments and restart recovery. Do not require Node's newer
built-in SQLite API without deliberately changing the supported runtime.

Each worker retains its own ordered source-event spool. The hub imports events
idempotently by `(executionId, executionGeneration, workerSequence)`. If the hub
restarts, the worker continues and catches it up. Serialize account commits, but
allow independent conversations/providers to run concurrently.

Use a tracked user-service/supervision configuration for restart and push delivery;
an active SSH client is not the supervisor. If a server has no supported persistent
user-service setup, expose that setup requirement. Server reboot recovery must
first reconcile provider/worker identity before starting a replacement.

## 4. Shared data and identity

| Record | Authority / conflict rule |
| --- | --- |
| Account | Random persistent `serverAccountId` created under the authenticated account; pair it with verified endpoint host keys. Matching titles/IPs are insufficient. |
| Endpoint aliases | Device-local addresses/trust entries point to the same verified account ID. A changed host key still requires host verification. |
| Agent project | Remote `projectId`, account ID, canonical folder, shared display name. Preserve separate agent and terminal project domains. |
| Conversation | Existing `meta.id` becomes the shared `conversationId`; remote record holds project, provider, title source, current execution, history generation and activity. |
| Execution | `executionId`, monotonic generation, provider-session ID, actual runtime/capabilities. Resume can replace execution while retaining conversation identity. |
| Transcript and requests | Server-ordered events plus materialized current request/turn state. Store the user's actual prompt before provider title-tool instructions are added. |
| Models/modes/Todos | Provider-acknowledged state. Todo revisions remain agent-owned and read-only to clients. |
| Organization | Shared project names, conversation titles, pins, archive and per-project manual order. Version each changed field/ordering record; stale edits return the newer value. |
| Read state | Shared per-user `readThroughSeq` for each conversation, merged with `max`. Advance only for actually viewed content; background fetch does not mark read. |
| Local drafts/settings | Device-local message/answer drafts, scroll anchors, attachment staging, SSH secrets, endpoint/key IDs, appearance and notification delivery settings. |
| Terminal | Shared reference to the exact existing account/tmux session and its generation; rendered screen/scrollback remains tmux/terminal state. |

The initial deployment has one personal user per remote account. A future
multi-user/team authorization model is separate work. SSH account access remains
the OS authority: unlinking Still registration does not revoke an independently
authorized SSH key or erase an offline cache.

### Organization behavior

- Rename, pin, archive, and reorder use typed patches; never replace the complete
  local `ConversationMeta` over remote data.
- Distinct field edits can merge. Conflicting edits to the same field return
  `revisionConflict` with the current value; preserve the uncommitted edit locally.
- A user-authored title takes precedence over later automatic title suggestions.
  Imported custom-agent definitions need explicit account-level adoption; provider
  execution paths and capabilities cannot be guessed from another device's label.
- Archive is reversible shared organization. It does not stop a task or discard
  an unresolved request; Needs you still exposes an archived task needing input.
- Device-only **Remove download** clears a cache. Shared **Delete conversation**
  writes a tombstone and prevents an offline device from resurrecting it. Remote
  deletion and execution shutdown have distinct command semantics.
- Cross-account ordering cannot be one atomic remote operation in this deployment.
  Share organization within each account; compose the multi-account home locally.

## 5. Sync and replay contract

Proposed interface names (not implemented IPC):

| Operation | Result |
| --- | --- |
| `account.hello` | Verified account identity, hub instance, protocol range, feature flags, registration state, current catalog cursor |
| `library.list` / `library.subscribe` | Bounded project/conversation/terminal summaries, tombstones and summary changes; include ended/saved work |
| `conversation.subscribe` | Snapshot/replay followed by live events from one durable boundary |
| `conversation.command` | Durable receipt or typed rejection for a scoped action |
| `operation.get` | Authoritative receipt for the same operation identity after acknowledgement loss |
| `organization.patch` / `read.advance` | Revision-aware shared metadata and monotonic read watermark |

Every event carries account/conversation identity, monotonic `conversationSeq`,
an immutable event ID, schema version, execution/generation where applicable,
and provenance. Device-native `sequence` stays a local implementation detail.
Catalog revisions and mutation/configuration revisions are separate from the
high-frequency transcript cursor.

### Canonical event projection

The server normalizes provider events once into the shared conversation format.
Move the required semantics currently in Rust's `agent.rs` to the worker/hub
boundary with cross-language fixtures. Rust caches these canonical records rather
than inferring a second, potentially different completion/request state per device.
Keep raw provider frames as bounded diagnostic/recovery evidence where needed.

Required shared records include accepted user messages and their message IDs,
assistant/reasoning/tool parts, acknowledged config, Todo snapshots, provider
checkpoints, request creation/outcomes, explicit turn results, and parent/child
links. Request outcomes record enough permitted response information for the other
device to understand the action; secret form values and raw permission arguments
follow field-level retention/redaction rules. The active request schema is fetched
from authoritative current state, not reconstructed from a redacted historic card.

Append rewind/active-history changes instead of reusing old sequence numbers;
history generation controls the visible branch. A `userMessage` first appears
locally as pending if necessary, then reconciles by `messageId` with the server's
accepted record and any provider echo. It never becomes two chat bubbles. Render
replayed imported history with its original provenance and partial-history marker.

### Opening or reconnecting

1. Render cached content promptly with last-sync information.
2. Verify/authenticate SSH, negotiate the account protocol and device registration.
3. Fetch catalog deltas. Discover new work and apply tombstones before advertising
   the library as current.
4. Subscribe from the locally committed cursor. Atomically select a snapshot at
   sequence **N**, register the live subscriber, replay through **N**, then stream
   **N+1** onward. Client buffers/deduplicates any overlap.
5. Validate scope and commit each batch plus its cursor to the native cache before
   advancing the displayed sync watermark. Reconnect from the last durable cursor.
6. Receive a caught-up marker including current turn, requests, config, Todos,
   execution generation and mutation revision. Then enable applicable mutations.

Page defaults: up to 100 catalog items; up to 256 history events or 1 MiB per page,
whichever comes first. Normalize larger tool results to bounded chunks or blob
references rather than exceeding a frame. Enforce quotas/backpressure and load
older history on demand; do not read the entire journal into RAM on every attach.
Compaction preserves a checkpoint and a verifiable retained suffix. An invalid or
out-of-range cursor requests a snapshot/history page, not a silent skip.

Separate UI facts: **connection** (offline/connecting/connected), **freshness**
(cached/catching up/current), **turn** (idle/running/waiting/outcome), and **pending
operation** (sending/accepted/checking result). An SSH connection alone does not
make a cached request actionable or establish that work succeeded.

## 6. Act from either device: mutation rules

There is **no persistent device controller and no Continue here button**. The
server has the single mutation authority for each conversation. All authorized,
caught-up clients can submit; the server serializes operations at the point where
their preconditions and side effects matter.

Example proposed command:

```json
{
  "protocolVersion": 4,
  "serverAccountId": "account-uuid",
  "conversationId": "existing-conversation-id",
  "operationId": "device-generated-uuid",
  "expectedExecutionId": "existing-execution-id",
  "expectedExecutionGeneration": 2,
  "expectedMutationRevision": 41,
  "kind": "prompt",
  "payload": {
    "messageId": "device-generated-message-uuid",
    "text": "Continue with the next change",
    "expectedConfigRevision": 7
  }
}
```

The authenticated channel binds `deviceId`/actor identity; a caller-supplied name
is only display metadata. Parent-agent commands have separately scoped identities
and enter the same lane as human commands.

### Command durability

1. Native client persists `operationId` and the exact payload before transmission.
2. Server authorizes scope and checks an existing receipt **before** reevaluating
   mutable preconditions. Same ID/payload returns that receipt; changed payload
   under an existing ID is rejected.
3. Validate execution/generation, target request/turn, and relevant revisions.
   Reserve the action and append its accepted user event/receipt durably as one
   commit before reporting **Accepted**.
4. Dispatch through the worker's durable inbox using the same operation identity.
   Map provider RPC IDs to operations; clients never compete for provider RPC IDs.
5. Publish provider acknowledgement and eventual outcome as distinct events.
   Acceptance means recorded intent, not task success.

Receipt states: `accepted → dispatching → acknowledged → completed | failed |
cancelled`, with explicit `unknown` when crash/transport evidence cannot establish
provider delivery. A provider without idempotency cannot be promised exactly-once
side effects. In that case preserve the uncertain receipt, reconcile the provider,
and block conflicting resubmission until the ambiguity is resolved. A timeout
does not allocate a fresh prompt ID or automatically replay a paid turn.

Fault-inject at each boundary: before acceptance commit, after commit/before reply,
before worker inbox commit, after dispatch/before provider acknowledgement, and
after outcome/before client cache commit. The hub reconciles an accepted receipt
against the worker inbox before redispatch; the worker marks a provider dispatch
intent durably before writing to the provider. A crash in that last write/ack window
requires provider-specific reconciliation, not an unconditional retransmit.

### Races and UI response

| Race | Deterministic behavior |
| --- | --- |
| Two devices send while idle | First valid commit reserves the turn. The other gets `busy`/`revisionConflict`; its text stays a draft. No implicit follow-up queue. |
| Response acknowledgement is lost | Query `operation.get`; repeated transmission with the same ID returns the receipt. Show Checking result until resolved. |
| Both answer the same request | Match a server-generated request UID plus kind/execution/generation/revision. First accepted answer claims it; later action sees Answer being sent/Already answered. |
| Old notification opens an answered request | Catch up and show the recorded outcome. No stale submit action. |
| Cancel arrives after another turn starts | Cancel names its `turnId`; return Already finished for the old turn, never cancel the new one. |
| One device changes model while the other sends | Compare acknowledged config revision. Serialize configuration and prompt acceptance; stale send keeps its draft and shows changed settings. |
| Concurrent Revert/Retry | Require idle conversation and expected history generation; execute one bounded operation in the same lane. Retry proceeds only after acknowledged revert. |
| Worker disappears; both clients request resume | Account hub reserves one replacement generation. Verify previous process/provider-session identity once; both clients observe the same result. |
| Connection drops during shared metadata change | Read the recorded operation/field revision; preserve pending edits and reconcile without replacing other fields. |

Mutating execution methods require current, caught-up state. Offline sends/answers
remain editable local drafts. Idempotent read-watermark advances may catch up later;
pending metadata changes are explicitly labelled unsynced and use revision checks.

## 7. Worker compatibility and existing-work adoption

- Publish capability negotiation before mobile writes: proposed worker protocol v4
  and features for account discovery, complete history, multi-client commands,
  request receipts, and shared metadata. Probe, rather than infer from app version.
- The hub connects once to each v4 worker and fans out its events. Protect that
  worker-facing attachment from old direct attach clients. It is server ownership,
  not whichever desktop/phone last reconnected.
- An old v3 worker keeps running under its existing protocol. A new phone may read
  imported history, but cannot attach through the replace-owner path. Show Requires
  continuity upgrade for live interaction until a verified safe transition.
- For a supported idle provider session, migrate at an explicit safe boundary with
  unchanged conversation/provider identities. Active or uncertain legacy work
  waits; opening the phone never restarts it.

Migration sequence: back up device journals → preview selected accounts/projects →
export shared fields and complete known history with provenance → idempotently
import by stable IDs → associate workers/provider sessions/terminal names → verify
counts, boundaries, and references → let the second device discover it. Keep native
originals for rollback. A crash resumes from an import checkpoint. If two histories
cannot be deduplicated from event/message provenance, retain both sources for
reconciliation instead of guessing from text or timestamps.

Imported outcomes are historical and create no fresh push alerts. Endpoint key IDs,
unsent drafts, local file paths and credential material are excluded. Shared
tombstones must dominate late imports; conflict/recovery output identifies any
incomplete transcript instead of treating it as a newly empty conversation.

## 8. Parent/child functionality

Move delegation dispatch and accepted guidance queues from the React workspace
into server-owned coordination. Store parent/child relationships, operation maps,
queue order and pause state remotely. A phone view, a desktop view, and a parent
tool then share one child command lane.

The first sync slice can prove a single-agent task. Do not advertise autonomous
cross-device subagents until a parent can spawn/guide/wait with **both apps closed**
and later replay the same child relationships. Preserve the existing one-level and
active-child limits, permission boundaries, and parent/human message provenance.

## 9. Setup and self-hosted alerts

### Setup

- Direct SSH setup works independently on each device. A desktop metadata QR/file
  shortcut can provide account/project references, endpoint hints and host-key
  fingerprints. Verify them over authenticated SSH before adopting the identity.
- Prefer a separately authorized SSH key and native secure storage per device.
  The QR path does not copy passwords/private keys. Device registration is a
  separate authenticated operation, with revocation for Still and push access.
- For mobile outside the LAN, use a reachable SSH endpoint or the user's VPN.
  Record the verified VPN/LAN endpoint aliases against the same account ID.

### Notification path

1. A server state transition durably creates an outbox entry with account,
   conversation, execution, request/turn, event ID and target registrations.
2. A supervised sender posts it to the user's HTTPS relay with scoped credentials.
   Relay stores bounded delivery attempts and sends FCM from server-side credentials.
3. Android receives a real native notification, using Needs input/Results/Failures
   channels and permission/lock-screen preferences. Payloads default to opaque IDs
   and discreet text; transcript and permission arguments stay on the SSH host.
4. Tap opens the exact route, authenticates, catches up and verifies current state.
   Opening a notification never submits an answer.
5. Duplicate delivery uses stable notification IDs; resolving elsewhere clears or
   updates a stale request. Replayed/imported events do not enqueue new alerts.

Initial retention proposal: expire undelivered request alerts when resolved or
after 24 hours; result alerts after 24 hours; retain delivery diagnostics without
content for seven days. Offline history remains available after alert expiry.
Retry bounded transient failures; retire invalid FCM tokens and re-register token
rotation. Record sent/received/opened independently of provider completion.

Before deploying: supply the user's relay host/TLS name, FCM project ownership and
registration credentials through deployment configuration. Test actual locked/Doze
delivery on the A142. Force-stop/reopen and permission denial require catch-up;
non-Google-services push remains a separate delivery choice.

Checked platform guidance: [FCM Android delivery](https://firebase.google.com/docs/cloud-messaging/android-message-priority)
requires time-sensitive priority to correspond to user-visible notifications and
limits receiver processing time. Render discreet notification copy immediately;
fetch the full conversation on open/catch-up rather than blocking the receiver on
SSH. Pin the actual Firebase SDK/API during S4. The
[Tauri notification plugin](https://v2.tauri.app/plugin/notification/) supplies
native display/channels; native FCM registration/receipt still needs integration.

## 10. Mobile functionality work tied to sync

| Flow | Required behavior |
| --- | --- |
| Threads home | Cached first paint, account sync status, shared Recent/Needs you, discover work from desktop and show answers from elsewhere. |
| Conversation | Bidirectional canonical messages, acknowledged controls, offline draft preservation, status separated from connection, stable reading anchor. |
| Requests | Exactly scoped current form/permission, submit receipt, duplicate/stale handling; unfinished local answers survive process recreation. |
| Review | Fetch server Git identity/snapshot when connected; distinguish cached/provider-reported edits. Preserve draft/back path. |
| Attachments | Native URI/grant or bounded private copy survives recreation; upload reference is shared only after a durable remote upload. |
| Terminals | Discover existing tmux identities; no new session created by opening an imported missing reference. |
| Android lifecycle | Real IME/insets/Back, incremental draft persistence, cold-start exact route, bounded reconnect on foreground, no background SSH polling dependency. |
| Settings | Real account/device connection state, last catch-up, remove-download versus shared deletion, and working notification registration controls. |

For terminal concurrency, **proposed separate policy:** viewers use a read-only,
non-resizing tmux attachment; **Use keyboard here** transfers input/viewport focus
for that terminal only. Conversation actions still work from either device. Verify
the supported tmux flags/version and remove account-wide resize side effects from
the current attach command before calling concurrent terminal use complete.

## 11. Implementation sequence: vertical proofs

| Slice | Work and existing task mapping | Observable exit |
| --- | --- | --- |
| S0 — Baseline | Complete real native SSH/auth/IME evidence, record current app/worker/provider builds (MOB-01) | Desktop and phone each independently reach the selected remote account; install/start evidence is already recorded separately. |
| S1 — Same remote work | Account identity/hub, v4 worker boundary, complete server history, non-destructive subscribers, native cache and library discovery (MOB-02, MOB-03.01–10, MOB-04.01–02) | Fresh phone discovers one desktop-created OpenCode task; both display the same full history and requests; disconnecting desktop leaves provider PID/session unchanged. |
| S2 — Act from either | Durable commands/receipts, execution fencing, authoritative request/config/cancel handling in desktop and Android (MOB-04, MOB-07.03/06–16) | Phone answers/sends while desktop is off; returning desktop catches up. Concurrent sends and answers yield one accepted action with preserved losing drafts. |
| S3 — Existing library | Shared organization/read cursors, terminal references, repeatable migration and legacy behavior (MOB-03.11–18, MOB-06, MOB-09) | User's existing remote projects/live-or-saved histories appear on both devices; rename/pin/archive/read converge and migration can be repeated safely. |
| S4 — Work with apps closed | Server subagent coordination, outbox, user's relay, native FCM and exact cold-start routing (MOB-02.15, MOB-10–12, AG-12 boundary) | Both apps closed: a request reaches the locked phone, response continues its original task, and parent/child orchestration does not depend on a mounted UI. |
| S5 — Daily-use release | Native attachments/review, terminal input/size policy, lifecycle hardening, reproducible signed update (MOB-05/08/13–15) | Full acceptance matrix on phone and desktop, including network loss, process death, upgrade and long histories. |

**Remaining release target:** complete native S1/S2/S3 acceptance and the explicitly
open migration/identity/FCM work. Use
OpenCode first because that is the demonstrated workflow in this conversation;
record exact server/runtime versions. Reuse the same contract for Codex, Claude,
Pi and Gemini, with provider-specific recovery/request tests before enabling their
write capabilities. Ship desktop and Android protocol support as a compatible pair.

### First end-to-end engineering slice

Use one remote account, one existing project and one OpenCode conversation. Build
the v4 account subscription and canonical history path, wire **both** real clients,
then add prompt and question/permission acceptance through that same command lane.
The exit demo is: desktop starts → phone discovers → phone answers → laptop goes
offline → phone sends → laptop returns to the same transcript/session. Include a
simultaneous-answer race and a dropped-ack replay in that demo. Broader organization
migration and push then build on a proven path, rather than a separate mobile-only
implementation. The milestone is not closed by an APK or fixtures alone.

### Bounded engineering packages

1. **Remote account/runtime:** add account identity/catalog/journal modules beside
   `src-tauri/agent-host/`; adapt bootstrap and supervisor with capability negotiation,
   worker-event import and one account hub. Implement durability/race tests first.
2. **Native sync/cache:** add explicit account/library subscription and command
   receipts to `nativeBridge.ts`, `tauriBridge.ts`, Rust agent/cache modules. Preserve
   current local-only stores until migration verifies; persist pending operation IDs.
3. **Client integration:** replace local-only hydration with cached + remote streams
   on desktop and MobileApp. Map provider outcomes to one shared projection; handle
   rejected/unknown mutations without dropping drafts or replacing sessions.
4. **Two-device proof:** install compatible builds; record the same conversation ID,
   provider-session ID and execution/PID while toggling desktop connectivity. Capture
   operation receipts and both device views for the central journey.

Planning these packages does not require a new global state library or separate
mobile provider implementation. The existing provider adapters, Todos, Git parser,
transcript renderer and native SSH are the foundation.

## 12. Required proof before claiming sync works

- New device discovers live **and ended** conversations without copied app storage.
- Submitted user messages and accepted settings are identical on both clients.
- Both devices can stay connected without `_still/replaced` or a reconnect fight.
- Two sends at once, two answers at once, and a lost acknowledgement do not dispatch
  duplicate work; typed rejection/uncertain states preserve local input.
- Model change races, delayed cancels and concurrent resumes target the right generation.
- Rename/pin/archive/read changes converge; offline edits cannot overwrite newer fields
  or resurrect deleted work. Drafts and endpoint credentials remain device-local.
- Desktop-offline phone interaction survives Android background/restart and network change.
- Catch-up during live streaming has no gaps; cache failure cannot advance its cursor.
- Migration interruption/rerun, corrupted suffixes, old clients and hub/worker crashes
  have recorded recovery behavior.
- Parent tools and locked-phone alerts operate with no connected UI where advertised.
- Existing desktop/native suites plus physical-phone scenarios pass for supported providers.

Implementation evidence records app build, hub/worker protocol, provider version,
device/Android/WebView, network and foreground/background conditions. Browser
fixtures verify interfaces; real two-device tests establish continuity.
