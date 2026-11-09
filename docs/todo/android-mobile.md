# AG-16 — Android phone application

Updated: **2026-11-09**. Status: **TODO — MOB-01 native build spike started;
ARM64 debug APK compiles; on-device runtime remains unverified**.

Feature status and scheduling remain in the [Agents tracker](README.md). This
document is the Android delivery specification for
[AG-16](agents-roadmap.md#ag-16-mobile-access), not a claim that mobile access,
cross-device history, or background notifications already work.

The detailed, checkable work breakdown is in the
[full Android implementation todo list](android-mobile-tasks.md). That checklist
owns individual task progress; this specification owns scope and acceptance rules.

## 1. Outcome and first-release boundary

The phone is a first-class client of remote work, not a small remote desktop.

> Start a task on desktop → leave the computer → receive an alert on Android →
> open the same conversation → answer or review → continue on either device.

### Confirmed product decisions

- **Android first; installable APK first.** Store distribution and iOS follow later.
- **Agents first.** Threads, requests, progress, conversation, and change review are
  the primary experience. Remote SSH/tmux terminals remain a useful secondary one.
- **Continue existing desktop work from day one.** A new phone must discover and
  continue the same remote-server conversations and terminal sessions, not start
  independent copies with similar names.
- **Remote-server work is in scope.** Connecting to agents or terminals running
  locally on the user's desktop is outside this first release.
- **Background alerts are required.** Notify when remote work needs an answer or
  has a confirmed outcome while the app is backgrounded or the screen is locked.
- Preserve the approved thread-focused, low-cognitive-load mobile direction below.

The remote server and its agent processes must remain available. Keeping the desktop
awake or connected must not be a prerequisite for using the phone. Android
force-stop, revoked permissions, network loss, and server failure have explicit
limitations; do not advertise guaranteed delivery under those conditions.

### First-release contents

1. Signed, upgradeable Android APK and a reproducible build.
2. Server setup, explicit host trust, safe SSH authentication, and desktop handoff.
3. Shared remote conversation discovery, history, and safe controller ownership.
4. Threads home, new task, conversation, questions/permissions, read-only Todos,
   activity, and read-only changes.
5. Photo/file attachments through Android pickers, subject to provider capability.
6. Background notifications and navigation to the exact request/conversation.
7. Remote terminals with practical touch input and persistent tmux identity.
8. Offline history/drafts, lifecycle recovery, accessibility, and physical-device tests.

### Explicitly outside the first release

- Running coding agents, Node.js, or a general local shell on the phone.
- Continuing a desktop-local execution without an independently designed host bridge.
- Play Store launch, iOS, smartwatch interfaces, or an Android overlay/orb.
- Full desktop parity: drag-and-drop organization, split terminals, full file IDE,
  worktree management, commit/push/PR creation, or scheduled tasks.
- Unattended approval from a notification, implied permission escalation, or silent
  offline prompt queues.
- An account service that stores SSH credentials, public access to workers, or
  exposing the development WebView/preview server as the production connection model.

## 2. Evidence and current gaps

Source inspection on 2026-11-09 establishes the following. A generated scaffold,
responsive browser test, or standalone mockup is not Android runtime evidence.

| Area | Current foundation | Required change / evidence |
| --- | --- | --- |
| Native host | React/TypeScript in Tauri 2; `src-tauri/src/lib.rs` has a mobile entry point | Compile, install, and exercise the real Android app; audit native modules and permissions |
| Android scaffold | Local `src-tauri/gen/android/` has Gradle, an edge-to-edge activity, and an Internet permission | Reproducible source-controlled configuration; that directory is ignored by Git |
| Conversation library | `src-tauri/src/agent_store.rs` is explicitly device-owned; `src/session/agentStorage.ts` persists native history | Remote discoverability and shared durable history, with device caches and migration |
| Agent execution | Detached workers and journals under `~/.local/state/still/agents/<execution-id>/` | Discover conversations without already knowing an execution ID; retain all required history and metadata |
| Controller | `supervisor.mjs` currently replaces the prior owner on `_still/attach` | Separate observation from control; explicit, race-safe transfer rather than reconnect battles |
| Duplicate protection | Existing stable prompt receipts and event cursors | Extend the same discipline to cross-device operations, approvals, ownership, and migration |
| Remote identity | Server/account and folder are chosen deliberately; current profile identity includes hostname/port/user | Associate aliases with verified server/account identity; preserve conversation/provider/tmux IDs |
| UI | Existing compact styles and browser regression tests | A phone shell with real Back, IME, insets, touch controls, recovery, and native accessibility evidence |
| Native APIs | Desktop keyring, clipboard, external-open, local PTY, window and orb paths exist | Platform capability boundaries; Android secure storage, pickers, links, and notification integration |
| Notifications | Structured conversation/request events exist; no production Android push path is established | Remote event source, durable notification outbox, delivery service, Android permission/intents |

The current remote replay journal must not be assumed to be a complete replacement
for native history. Verify user messages, accepted configuration, attachments,
request outcomes, closed executions, and provider resume references individually.

## 3. Approved mobile UI and UX

### Visual authority and portability

The reviewed artifact is the sibling directory
[`mobile-mockup/`](../../../mobile-mockup/README.md), especially
[`DESIGN.md`](../../../mobile-mockup/DESIGN.md), `index.html`, `mockup.css`, and
`mockup.js`. It is a **synthetic interaction study**, not application code to ship.
It lives outside this repository; these relative links only work in the full local
workspace. The durable decisions are copied into this document so Android work does
not depend on a LAN URL, a sibling checkout, or an Impeccable session remaining open.

Before implementation, bring the selected reference captures and licensed font
assets into a reviewed, repository-owned location. Preserve license notices. Do
not import example models, fake servers, the simulated keyboard, or mockup state
handlers into the production app.

### Navigation

```text
Agents / Threads — default destination
  Recent | Needs you
  Search and project filter
  New task
  Conversation
    Question or permission request
    Todos / tool activity
    Changes → file diff

Terminals
  Remote sessions → terminal

Settings
  Servers / credentials
  Connected devices / pairing
  Notifications
  Reading, motion, and terminal preferences
```

- A phone opens directly into **Threads**, never a terminal connection screen.
- Three root destinations retain the approved floating glass island. Active
  destination expands to show its label; inactive icons have explicit accessible
  names. No dock on focused conversation, request, diff, or terminal screens.
- Keep **Recent** and **Needs you** only on the default thread list. Do not add
  another permanent Active/Completed/unread/project dashboard. Other filters may
  live in the search/project sheet when genuinely needed.
- First-release phone layout is one column. At expanded window sizes, a rail and
  list/detail layout may reuse desktop components; do not lock orientation or break
  Android multi-window to avoid layout work.
- Preserve draft, list filter, and scroll position on return. Back closes IME, then
  sheets/detail, then returns to the parent route; root Back remains Android-owned.

### Screen requirements

| Surface | Production requirement |
| --- | --- |
| Threads home | Clear Threads heading; recent list as the main surface; inline attention/working/outcome states; quiet search and project selection; no large hero, separate attention card, duplicate timestamps, or connected-server footer |
| New task | Compact outlined, circled-plus **New task** pill right-aligned above the dock, without a surrounding panel; explicitly choose server/project before preparing an agent; provider/model controls use actual negotiated support |
| Conversation | Latest accepted **Quiet transcript + Editorial signal**: confident title and speaker roles, unboxed user prompt with subtle left rule, readable agent response, compact execution/control state, anchored composer |
| Execution context | Distinguish working/request/outcome from connectivity and device control. Do not repeat origin in four rows. Keep project/account details reachable from conversation info even when hidden in the title bar |
| Handoff | Reading never silently steals control. Show **Continue here** when another device controls mutations. After confirmed transfer, update both devices and prevent the old controller from auto-reclaiming ownership |
| Requests | Attention link opens the same question/permission in a focused screen with context, large options, optional answer, persistent submit, sending/error/outdated states, and a confirmed receipt |
| Todos | Collapsed current step/count; read-only expansion. Checklist progress is not turn completion, test success, or an editable user checklist |
| Activity | Secondary disclosure, not a permanent stream of every event. Expand relevant tool details without losing the reading position |
| Changes | Full-screen unified diff; file selector and next/previous; optional wrap; horizontal scrolling only inside code. Keep provider-reported conversation edits distinct from a fresh Git snapshot |
| Terminal library | Remote session name, host/project, and last-known connection state. Continue the same tmux name; no phone-local shell disguised as remote work |
| Settings | Servers, device connections, credential controls, notification channels/privacy, readable-text/motion and terminal preferences. Unsupported options are explained, not fake enabled controls |

### Typography, material, and cognitive-load rules

- **Bricolage Grotesque** for major headings and the reviewed Still wordmark;
  **Source Sans 3** for UI/reading; a suitable monospace for code/data. Self-host
  licensed assets. This direction is mobile-scoped, not a desktop-wide restyle.
- Role scale, not arbitrary per-component numbers: approximately 36–40px screen
  heading, 18–20px conversation title, 15–16px thread titles, 15–16px reading copy,
  and 12px-or-larger meaningful metadata, adjusted for font metrics and OS scaling.
- The mockup's 9–11px metadata and 40–44px controls are **not** the production floor.
  Use Android-appropriate 48dp minimum targets and validate 200% text scaling,
  contrast, TalkBack, long titles, long paths, Unicode, and RTL where supported.
- Retain near-black/rose identity and the floating smoked/liquid-glass dock. One
  intentional material, bounded blur, no stack of glass cards. Provide an opaque
  fallback for weak GPUs, unavailable effects, reduced transparency, or preference.
- Preserve status text and accessible names. Color, animation, and tiny glyphs
  alone must not communicate pending approval, failures, or completion.
- No permanent desktop sidebar, draggable title-bar controls, extra status boxes,
  desktop window morph, simulated system bar, device frame, or critique side rails.

### Composer and keyboard contract

1. Enter inserts a newline on the soft keyboard; **Send** submits explicitly.
2. Test Android IME composition, autocorrect, dictation, emoji, selection, multiline
   paste, physical keyboard shortcuts, and composition ending near submission.
3. Apply real window/IME/cutout/gesture insets. Composer, pending-request actions,
   and sheet controls never sit behind the keyboard or system bars.
4. Keep draft and selected attachments across navigation, rotation, app background,
   and process recreation. Persist drafts locally before relying on suspend events.
5. Model, mode, effort, slash commands, and attachments use touch sheets; serialize
   configuration changes and show provider acknowledgements. Never submit a draft
   while changing a model. Do not copy the mockup's separate effort button if the
   production provider menu already owns that setting.
6. Do not yank a reader to the bottom on every streamed token. Retain scroll anchor
   and show Jump to latest when the user is reading earlier output.
7. Offline/unknown-delivery drafts remain editable, but no silent autosend or blind
   retry. A durable follow-up queue is the separate [AG-06](agents-roadmap.md#ag-06-queued-follow-ups-and-steering) contract.

## 4. Architecture recommendation and decision gates

**Recommendation, not yet a finalized protocol:** reuse React + Tauri 2, native SSH,
existing provider adapters and persistent workers. Add a phone shell and narrowly
scoped native Android integration. Do not start with a React Native/Compose rewrite
or a browser-only SSH gateway.

```text
Desktop client ── authenticated SSH ──┐
                                    │   remote account
Android client ── authenticated SSH ─┼─ conversation catalog + durable history
                                    └─ persistent worker/provider per execution
                                                     │
                                            notification outbox
                                                     │ outbound HTTPS
                                            authenticated push relay
                                                     │ FCM
                                              Android notification
```

The phone reads and mutates work through authenticated server access, not through
an always-online desktop. Workers remain private to the server account; no new
inbound public worker port is implied. Push delivery is a separate, proposed
egress-only path, not a replacement source of conversation truth.

### Decisions to resolve before their dependent implementation

| Gate | Proposed default | Why it needs a decision / proof |
| --- | --- | --- |
| MOB-D1 — Client stack | React/Tauri 2, shared domain logic and a mobile shell | Real Android compile plus SSH/IME/native-API spike must pass; scaffold presence is insufficient |
| MOB-D2 — Continuity authority | Account-scoped remote catalog/history; device-local cache/drafts | Requires explicit history-sharing/migration and retention contract, not just copying desktop profiles |
| MOB-D3 — Controller model | Multiple readers; one authorized mutating controller per conversation, with explicit transfer | Must coordinate with AG-10/AG-12 and old single-owner workers; no reconnect takeover loop |
| MOB-D4 — Push deployment | Small authenticated notification-only relay + FCM; optional self-hosted deployment contract | Hosting operator, credentials, cost, privacy, retention, revocation, and non-GMS policy must be selected |
| MOB-D5 — Pairing | Metadata-only QR/config exchange plus independent SSH authentication | A six-digit mock code is not secure pairing or an Internet rendezvous service |
| MOB-D6 — Android support | ARM64 APK first; x86_64 emulator for CI; establish minimum OS with the first physical devices | Do not inherit min/target SDK values from ignored generated files as a release policy |

Saving this plan authorizes no cloud provisioning, new public endpoint, credential
transfer, source migration, or recurring service. Those are implementation decisions
with their own review. None of these decisions requires resuming the deferred orb UI.

## 5. Shared conversations and safe handoff

### Authority and data boundaries

| Data | Intended owner / behavior |
| --- | --- |
| Provider execution, pending requests, acknowledged outcomes | Remote worker/provider, with durable normalized state |
| Conversation ID, project/account association, current execution/provider-session references, title, replay history | Remote account catalog/history, revisioned and discoverable; native store caches it |
| SSH passwords/private keys | Device-native secure storage only; never library, relay, QR, or WebView persistence |
| Draft text, unsent answers, unuploaded attachments, reading position, pins/display preferences | Device-local first; no silent overwrite from another device |
| Device read cursor and notification preferences | Device-scoped. Cross-device read synchronization may follow, but answered requests are shared state immediately |
| Cached history | Readable offline; clearly last-known until authoritative catch-up completes |
| Git snapshot | Fresh server query with timestamp/repository identity, not assumed from a chat's reported patches |

### Minimum shared contract

- Stable `serverAccountId`, project identity/canonical folder, conversation ID,
  execution ID, and confirmed provider-session ID. Host aliases are verified
  endpoints for an identity, not separate conversations by default.
- Preserve existing IDs and tmux names during adoption. Never match by title alone
  or equate the SSH hostname string with verified server identity.
- Versioned, bounded listing and per-conversation replay APIs over existing SSH
  transport. Discover live **and saved/ended** conversations, not just socket files.
- Durable event/source sequence and operation IDs. Replay duplicates do not create
  duplicate messages, request cards, Todos, or completion alerts.
- Atomic catalog/metadata updates with revision checks and account-private storage.
  Concurrent title/project updates must not clobber newer data silently.
- Shared request identity includes conversation, execution/attempt, request kind and
  request ID; numeric provider request IDs alone are insufficient.
- Schema negotiation reports unsupported/unverified features. An old worker is not
  silently restarted just because the phone cannot observe it with the new protocol.

### Controller state machine

```text
cached/offline → authenticated reader → caught-up reader
                                      ↓ acquire if no active controller
                              current controller
                                      ↑ explicit transfer, expected owner epoch
another device controls → Continue here → acknowledged ownership change

uncertain mutation → reconcile receipt/current state → confirmed or safe failure
```

- Observation does not use the current destructive attach behavior. Introduce a
  negotiated observer path before allowing both devices to watch the same worker.
- Server-side serialization and a monotonically changing ownership epoch/lease
  fence **all** mutating calls: prompt, answer, cancel, model/mode change, revert,
  retry, and close. A stale controller cannot write after transfer.
- Ownership is per conversation, not a global phone/desktop switch. Taking one
  conversation must not transfer unrelated conversations or another account.
- Backgrounding/losing a lease does not cancel remote work. Reopening reconnects
  as a reader, reconciles state, and reacquires only when safe; it must not steal
  the lease back from the device the user deliberately chose.
- Acknowledge a durable operation/receipt separately from provider completion.
  After a lost acknowledgement, query outcome before allowing resubmission.
- Handle simultaneous takeovers and already-answered questions deterministically.
  Show the new controller/outcome; keep unsent local text.
- Coordinate Still-managed parent/child messaging with
  [AG-12](agent-subagents.md#runtime-ownership-and-persistence). A phone viewing a
  child must not disconnect its parent coordinator. Do not invent a second child
  submission authority or make mobile depend on shipping all of AG-12.

### Existing-history migration

1. Desktop offers explicit **Enable phone continuity** for selected remote accounts/
   projects and explains which conversation data will be stored on those servers.
2. Back up current native history. Build a restart-safe, versioned export of
   durable conversation metadata and transcript, not credentials or unsent drafts.
3. Seed/merge the remote catalog by stable IDs and event provenance. Re-running
   migration is idempotent and retains old native files until verified.
4. Link each live worker, saved provider session, remote attachment, and tmux
   session to its existing identity. Upgrade compatible workers at a safe boundary;
   retain read-only/needs-upgrade behavior for incompatible running workers.
5. Phone imports remote references into its native cache. Missing historic data
   remains honestly incomplete/read-only; it is not permission to duplicate a run.
6. Imported historical outcomes do **not** produce new finished-work notifications.

Archiving/deleting needs explicit scope. For the first release, device-local archive
and read preferences may remain local; destructive deletion of shared history must
be a separate, confirmed operation with durable tombstones and recovery policy.

## 6. Connection setup, pairing, and security

- Phone can add and authenticate to a remote server directly; pairing is a faster
  metadata setup path, not the sole way to connect.
- A desktop QR/config descriptor may include endpoint/account/project identifiers,
  verified host-key fingerprint, protocol version and an expiring one-time device
  registration grant. It must contain **no SSH password/private key**.
- Phone independently authenticates and verifies server trust before adopting the
  shared catalog. Pairing cannot silently bless a changed host key.
- The six-digit example and simulated QR scanner in the mockup are not real flows.
  If code-only pairing is chosen, first design an authenticated rendezvous and
  confirmation path, expiry, attempt limiting, replay protection, and revocation.
- Prefer separately authorized per-device SSH keys. Store secret blobs encrypted
  with a Keystore-held key in private Android storage; do not assume the desktop
  `keyring` integration supplies this automatically.
- Unlinking a device stops its Still registrations/control and push access. It does
  not magically revoke an independently provisioned SSH key or remotely erase
  downloaded history; show those boundaries and how to remove SSH authorization.
- Do not put secrets, full transcripts, raw permission arguments, or private file
  contents into diagnostic events, clipboard by default, QR codes, analytics, or
  push payloads. Define backup exclusions for credentials and sensitive cache data.
- Validate native IPC arguments, external URLs/intents, attachment paths and
  project/account scope. Ship an intentional Android CSP/capability set; do not
  copy the development server's open network/security configuration.

## 7. Background notification delivery

This is required release work, not an optional polish task and not satisfied by
displaying a local notification while the WebView happens to be running.

### Delivery responsibilities

1. Persistent remote execution publishes normalized **needs input**, **confirmed
   turn outcome**, and meaningful failure events independent of desktop lifetime.
   Reuse truthful AG-01/AG-05 semantics; terminal activity or a completed Todo is
   not proof of a successful turn. Where normalization currently lives in the
   native desktop parser, move/share the required reducer with the remote notifier.
2. A durable per-account/worker outbox records notification intent and stable
   deduplication key before acknowledging dispatch; remote operation must not block
   on push availability. Retry with bounds/backoff and expiry.
3. An authenticated relay accepts only scoped device/server registrations and
   notification kinds; it sends through FCM. Rate-limit, rotate/revoke credentials,
   track token replacement, and keep content retention minimal.
4. Android integrates actual FCM receipt, notification channels, runtime permission,
   lock-screen privacy, and app navigation. Verify plugin/native Kotlin support;
   a generic Tauri local-notification plugin is not proof of remote push support.
5. A notification contains opaque routing/event identifiers and discreet copy by
   default. On tap, Still authenticates, catches up, verifies the execution/request
   is still current, and opens the exact screen. No notification-tap auto-approval.

### Required states and limits

- Separate Needs your input / Work ready / Failures categories and per-thread mute.
  Never notify for each token, tool update, replay event, or duplicate parent summary.
- Request notification permission contextually; denial leaves the app usable and
  shows recovery through Android settings, not a fake enabled switch.
- Stale request → **Already answered / no longer active**; worker unavailable →
  recovery screen; offline → cached thread plus reconnect explanation.
- Test cold start, background, process reclamation, locked/Doze devices, token
  rotation, revoked pairing and duplicate delivery. A force-stopped app may not
  receive pushes until reopened; it must catch up safely on the next launch.
- First-release FCM coverage presumes Google Play services if MOB-D4 adopts it.
  Non-GMS delivery needs a separate approved provider/support policy. Do not quietly
  substitute best-effort background SSH polling for the required notification path.
- Server/network/OEM restrictions prevent an absolute instant-delivery guarantee.
  Capture measured delivery behavior and failures on supported physical devices.

## 8. Native Android and terminal implementation

### Platform boundary

Keep shared agent state, request validation, transcript rendering, provider
capabilities, Git parsing, and native SSH behind the existing bridge. Introduce a
small explicit platform-capability adapter for window actions, credentials,
clipboard, pickers, insets, Back, app lifecycle and push.

- No desktop minimize/close/maximize, draggable frame, separate orb window, or local
  PTY initialization on Android. Gate compilation/dependencies and UI affordances,
  rather than letting unsupported calls fail at runtime.
- Android entry defaults to the mobile shell. Preserve the current desktop shell;
  extract common components/state instead of forking provider and persistence logic.
- Persist native history/drafts incrementally. App background/suspend must tolerate
  immediate process death; a final WebView flush is not a durability guarantee.
- Pause decorative rendering off-screen; cap active canvases and blur surfaces.
  Use an opaque material if budget/device capability requires it.
- Use system photo/file pickers and appropriate URI grants/private temporary copies.
  Files survive supported process-recreation paths until upload/cancel. Bound file
  size/count, preserve upload progress and retry state, and clean private temporary
  files. Request no broad filesystem/media permission just to attach one file.
- Copy/paste and external URLs use explicit user actions and Android-supported APIs.
  Image/file interpretation remains capability-gated; choosing an image does not
  establish that every provider understands it.

### Terminal minimum

- Keep `SessionTerminal`/xterm and the native remote SSH/tmux path if the real-device
  input spike passes. Validate selection/IME before committing to the entire screen.
- Special-key rail: Ctrl latch, Esc, Tab, arrows, paste, keyboard show/hide, readable
  text size and a way to reach less-common keys. Targets must stay usable on 320px
  windows; horizontal toolbar scrolling is preferable to tiny key targets.
- Distinguish scrolling history from sending TUI mouse input; long-press selection
  and Copy must be discoverable without desktop Ctrl shortcuts.
- Keyboard/orientation resize must fit the visible viewport without reconnecting,
  discarding output, or renaming the tmux session. Define and test simultaneous
  desktop/phone viewport ownership so the phone does not continually shrink the
  desktop's TUI. Reading an inactive session must not resize it repeatedly.
- Leaving a terminal view keeps remote work running; explicit Disconnect drops the
  transport, not the persistent tmux session. Stopping remote work is separate.
- Preserve host-key prompts, credential flows, external-keyboard behavior, paste
  confirmation for potentially dangerous multiline input, and offline/error states.

## 9. Delivery sequence and implementation checklist

All tasks below start **TODO**. UI work can proceed against a typed fixture after
the shared contracts are agreed; completed mockup screens do not close native,
provider, continuity, or notification tasks.

Each milestone is expanded into concrete checkboxes, dependency notes and evidence
requirements in [android-mobile-tasks.md](android-mobile-tasks.md). Use that file
for execution tracking rather than treating a summary-table row as a completed task.

| ID | Deliverable | Depends on | Done when |
| --- | --- | --- | --- |
| MOB-01 | Native feasibility APK and compatibility inventory | MOB-D1/D6 spike | Real ARM64 phone starts; native SSH, one agent exchange, credential persistence, terminal IME and suspend/resume paths have recorded results |
| MOB-02 | Versioned identity/catalog/history/ownership contract | MOB-D2/D3 | Desktop-offline continuity, aliases, caches, operation receipts, revisions, compatibility and migration rules are reviewed together |
| MOB-03 | Remote catalog, complete replay and migration | MOB-02 | A fresh authenticated device discovers an existing live and saved conversation with the correct history/provider identity; rerunning migration is safe |
| MOB-04 | Observer/control transfer and mutation fencing | MOB-02; AG-10/12 coordination | Two clients can read; explicit takeover is race-safe; stale writers and duplicate/uncertain requests are rejected/reconciled |
| MOB-05 | Phone routing, insets, Back and native persistence lifecycle | MOB-01; reviewed UI direction | Root/detail navigation, real IME, rotation/process recreation, and draft/scroll restoration work on-device without desktop chrome |
| MOB-06 | Thread library, search/filter and new task | MOB-03/05 | Thread-first home shows remote/cached truth; explicit project/agent setup works with negotiated model controls |
| MOB-07 | Conversation, requests, Todos and capability states | MOB-04/05/06 | User can read, continue, answer, cancel safely, inspect progress/activity and recover unknown submissions without duplicate work |
| MOB-08 | File review and Android attachments | MOB-05/07; AG-02a/04 contracts as used | Unified file review and bounded system-picker upload work; source/capability distinction and error recovery remain truthful |
| MOB-09 | Pairing/device registration and secure credential adapter | MOB-01/02; MOB-D5 | Phone adds a server or adopts metadata without receiving secrets; trust, registration expiry and revocation are tested |
| MOB-10 | Remote notification event source and durable outbox | MOB-02; shared status/AG-05 contract | Needs-input/outcome is produced without a desktop/phone connection; history imports and retries do not create false duplicate alerts |
| MOB-11 | Push relay and Android notification integration | MOB-09/10; MOB-D4 | Registered locked/background phone receives a real alert; permission, privacy, token rotation and revocation work |
| MOB-12 | Notification routing and catch-up | MOB-03/04/05/11 | Cold-start tap opens the exact current request/result; stale and offline cases do not submit actions |
| MOB-13 | Touch terminal and tmux continuity | MOB-01/03/05 | Real SSH terminal input, selection, special keys, resize and existing-session continuation pass physical-device checks |
| MOB-14 | Security/accessibility/performance hardening | MOB-06–13 | The acceptance matrix passes with hostile/stale input, TalkBack, large text, constrained devices and network changes |
| MOB-15 | Reproducible signed APK, upgrade and release evidence | MOB-14 | Clean checkout builds; signed install/update preserves expected data; support matrix and known limitations are documented |

### Critical path

1. **Prove Android reality:** MOB-01; decide platform blockers before polishing CSS.
2. **Prove continuity:** MOB-02–04 plus a minimal phone reader/answer flow.
3. **Prove the central journey:** real desktop task → locked-phone request alert →
   answer on the same execution → desktop observes outcome. This requires MOB-09–12,
   not an always-on preview page or a mocked notification.
4. **Complete the mobile interface:** MOB-05–08 and MOB-13, using those real contracts.
5. **Harden and package:** MOB-14/15. No final-release declaration from fixture tests.

Do not spend the first milestone recreating every mockup screen before testing SSH,
IME, ownership, or push. These are the expensive failure risks. No calendar estimate
is committed until the native and continuity spikes establish their actual gaps.

### Source entry points, not mandated new modules

| Work | Existing entry points |
| --- | --- |
| Mobile shell / route extraction | `src/App.tsx`, `src/main.tsx`, `src/screens/Workspace.tsx`, `src/components/AgentWorkspace.tsx`, `RemoteAgentWorkspace.tsx` |
| Transcript, request and review reuse | `src/components/AgentTimeline.tsx`, `AgentRequest.tsx`, `AgentControls.tsx`, `AgentTodos.tsx`, `AgentReviewDiff.tsx`, `src/agents/` |
| Typed native/platform boundary | `src/bridge/nativeBridge.ts`, `tauriBridge.ts`, `src/types/`, `src-tauri/src/lib.rs`, `commands.rs`, `Cargo.toml`, capabilities/config |
| Identity, local cache and recovery | `src/session/identity.ts`, `agentStorage.ts`, `agentThreads.ts`, `src/agents/workspace.ts`, `src-tauri/src/agent_store.rs`, `agent.rs` |
| Remote catalog/control/outbox | `src-tauri/agent-host/bootstrap.mjs`, `supervisor.mjs`, provider transports; introduce only the narrowly scoped shared service/data modules required |
| Touch terminal | `src/terminal/SessionTerminal.tsx`, `clipboard.ts`, `links.ts`, `src/session/connections.ts`, native SSH/tmux worker |
| Android integration/build | `src-tauri/gen/android/` as current local scaffold only; establish tracked templates/config/plugin sources and CI before relying on edits there |
| Regression evidence | `tests-agents/`, `tests-terminal/`, Rust tests, new Android instrumentation/physical-device matrix |

## 10. Acceptance matrix

| ID | Scenario and observable pass condition |
| --- | --- |
| AND-A01 | Clean checkout builds a signed ARM64 APK through the documented process; install and upgrade preserve expected cache/settings and never expose credentials |
| AND-A02 | Fresh phone authenticates to a selected server, verifies its host key and discovers existing desktop remote conversations without creating duplicate sessions |
| AND-A03 | With desktop powered off, phone reads and continues the same remote conversation/provider session; draft text is never silently submitted |
| AND-A04 | Two readers coexist; explicit Continue here transfers only that conversation; old-owner reconnect cannot reclaim it or write with a stale epoch |
| AND-A05 | Lose the network before/during/after prompt acknowledgement; catch-up uses the same message ID and produces no duplicate paid turn |
| AND-A06 | Answer a request on desktop while phone has it open; phone shows Already answered and cannot apply a stale answer to a newer execution |
| AND-A07 | Rotate, background, reclaim/restart the process, and reopen sheets with a draft/attachments present; expected local content and reading position restore safely |
| AND-A08 | Gboard/Samsung keyboard and a hardware keyboard handle composition, newline, Unicode, paste, Send, keyboard dismissal and layout insets without hidden controls |
| AND-A09 | Wi-Fi → cellular → VPN loss/restoration yields clear cached/reconnecting/current states without changed host trust, duplicate messages, or active-worker cancellation |
| AND-A10 | Remote request/confirmed outcome reaches a locked/background registered phone without desktop connectivity; tap from a cold start opens its actual current thread/request |
| AND-A11 | Denied notification permission, Doze, token rotation, duplicate push, revoked registration and force-stop/reopen follow documented behavior; none auto-approve work |
| AND-A12 | Conversation patches and repository snapshots stay distinct; large/long/binary/truncated diffs remain bounded and navigable; cancelled uploads preserve the unsent task |
| AND-A13 | Real terminal selection, scrolling, Ctrl/Esc/Tab/arrows, paste, keyboard/orientation resize and reattach preserve tmux identity; concurrent client resize behavior is deliberate |
| AND-A14 | 320px compact viewport, landscape and multi-window fit; 200% text scaling and TalkBack expose navigation/request controls, focus return and full control names |
| AND-A15 | Long transcript and active streaming remain responsive on a mid-range phone; no hidden-window animation loop, unbounded output/DOM, or sustained background SSH-polling battery drain |
| AND-A16 | Migration rerun/crash, old worker protocol, missing provider session, corrupted cache and unavailable server do not discard history or silently replace uncertain execution |
| AND-A17 | Device unlink, host-key mismatch, forged/stale intent, untrusted attachment metadata, cross-project ID, and unauthorized control mutation are rejected with useful recovery |
| AND-A18 | Existing desktop agent/terminal suites pass; phone implementation does not regress desktop navigation, persistence, host trust or the deferred orb's current behavior |

Run domain/worker/native tests first, responsive browser checks next, emulator/Android
instrumentation next, and the physical-device journey last. Record app/worker/provider
versions, OS/WebView/keyboard versions, device class, network setup and results.

At minimum include a Google-services phone with current gesture navigation and a
second OEM/mid-range phone, button navigation, notification-permission OS versions,
and an emulator matching the supported minimum. Choose the final OS/API matrix in
MOB-D6; keep target SDK/store policy current at release time.

Performance acceptance should measure the real path: bounded memory on long history,
frame responsiveness during streaming/scrolling, time to cached first paint, and
remote catch-up separate from network latency. Set numeric budgets after MOB-01's
baseline, before MOB-14; do not claim those budgets are met from the mockup.

## 11. Relationship to existing roadmap

- **AG-01 / AG-05:** reuse typed status, request, unread and notification semantics.
  Extract the shared data foundation without waiting for the deferred floating orb.
- **AG-02a:** reuse read-only Git identity/snapshot rules. Mobile release does not
  imply shipping commit/push/PR workflows.
- **AG-04:** reuse attachment/message-parts and remote-path contracts. Android
  picker/URI support remains its own native work.
- **AG-10:** coordinate import/adoption and active-controller behavior rather than
  implementing a second incompatible discovery/ownership model.
- **AG-11 / AG-18:** actual provider capabilities and shared Todo truth remain the
  source; example model/plan controls are not production defaults.
- **AG-12:** child relationships must survive mobile replay. Direct child chat uses
  the same ownership/queue rules; no floating multi-panel desktop layout on a phone.
- **AG-15:** version migration/export formats together, but a general portable backup
  product is not required to unblock the bounded continuity migration.

This planning update expands the old desktop-companion-only AG-16 assumption. It
does not automatically reorder the currently active capability/Todo/Git milestones,
mark mobile implementation started, or approve a relay deployment. Record scheduling
changes explicitly in the master tracker when implementation is authorized.

## 12. References

- [Current agent behavior and persistence](../agents-ui-and-persistence.md)
- [Provider capability audit](provider-capabilities.md)
- [Subagents and direct chat](agent-subagents.md)
- [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/#configure-for-mobile-targets)
- [Tauri Android distribution](https://v2.tauri.app/distribute/google-play/)
- [Android edge-to-edge and insets](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- [Android Back navigation](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture)
- [Android notification permission](https://developer.android.com/develop/ui/views/notifications/notification-permission)
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
- [FCM Android delivery priority and power behavior](https://firebase.google.com/docs/cloud-messaging/android/message-priority)

Provider, plugin and OS support must be checked against actual dependency/runtime
versions during the implementation spikes; linked platform documentation does not
prove Still's current adapters already provide the behavior.
