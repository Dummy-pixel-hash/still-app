# AG-16 — Full Android implementation todo list

Updated: **2026-11-09**. Status: **TODO — checklist recorded; implementation not started**.

Scope and product decisions live in the [Android phone plan](android-mobile.md).
Feature scheduling/status remains in the [master tracker](README.md#master-tracker).
This file owns the detailed Android task checkboxes; the plan's MOB-01–15 table is
the milestone/dependency summary, not a second completion tracker.

## How to use this checklist

- All items start unchecked. Saving the plan, finishing an HTML mockup, or passing
  browser fixtures does not complete production/native tasks.
- Keep IDs stable. Record actual blockers with the affected ID; do not hide an
  unresolved dependency by checking an implementation item as complete.
- A milestone is complete only when its required subitems, verification, and linked
  acceptance conditions have evidence. Individual checked tasks do not mean AG-16
  is DONE.
- Beside a completed item, record the commit/reference and relevant test/device
  evidence. Put longer evidence under that milestone's verification entry.
- Decision items mean **document and approve a decision**, not provision resources.
  No relay/cloud deployment, credential transfer, or history migration is authorized
  by this checklist alone.
- Dependencies are interfaces and capabilities, not a requirement to finish every
  unrelated AG feature. In particular, mobile does not require the deferred orb UI.
- Do not create another provider state machine, credential store in JavaScript, or
  demonstration-data path in production to make an item appear complete.

## Delivery order

| Stage | Work | Exit condition |
| --- | --- | --- |
| 1 — Native proof | MOB-01; initial MOB-D1/D6 decisions | APK on a real phone, native SSH/agent exchange and terminal IME verified |
| 2 — Continuity proof | MOB-02–04; minimal MOB-05/07/09 | Phone reads and continues the same execution while desktop is offline |
| 3 — Essential mobile journey | MOB-10–12 plus the minimum request UI | Locked phone receives a real request alert and answers the same conversation |
| 4 — Complete phone UX | MOB-05–09 and MOB-13 | Approved screens, attachments/review, settings and terminal work with real data |
| 5 — Release proof | MOB-14/15 and AND-A01–18 | Security/accessibility/device evidence and a signed, upgradeable APK |

UI implementation can proceed against a typed fixture once contracts are defined;
integration and native evidence are still mandatory. This order does not silently
override currently active desktop work in the master tracker.

## Decisions and release boundaries

- [ ] **MOB-D1** — Client stack. Record the React/Tauri/native-SSH choice after the
  feasibility spike, including Android-specific modules and any proven blocker.
- [ ] **MOB-D2** — Data authority. Approve remote catalog/history ownership, local
  cache/draft boundaries, history-sharing consent, migration and retention policy.
- [ ] **MOB-D3** — Control ownership. Approve observer/controller roles, per-thread
  lease/epoch rules, mutation fencing, recovery and legacy-worker compatibility.
- [ ] **MOB-D4** — Push deployment. Select relay hosting/operator, FCM credentials,
  security model, retention, operating cost, registration/revocation and non-GMS policy.
- [ ] **MOB-D5** — Pairing. Select metadata-only QR/config transfer versus an approved
  code-rendezvous design; document authentication, host trust, expiry and replay limits.
- [ ] **MOB-D6** — Android support. Set minimum/target SDK, ARM64 release and emulator
  targets, supported WebView range, physical test devices and update compatibility.

## MOB-01 — Native feasibility APK and compatibility inventory

Dependencies: initial MOB-D1/D6 assumptions. The spike provides evidence to finalize
those decisions; a generated Android directory is not a completed spike.
Acceptance: [AND-A01/A08/A13/A18](android-mobile.md#10-acceptance-matrix).

### Initial implementation evidence — 2026-11-09

- **Proved:** AArch64 Rust/Tauri Android library and debug APK package compile using
  JDK 17, Android SDK 37, NDK 27.1.12297006 and `aarch64-linux-android`. The APK
  reports package `dev.still.app`, min SDK 24, target SDK 37, and verifies with APK
  Signature Scheme v2.
- **Command:**
  `ANDROID_HOME=/mnt/data/android-sdk ANDROID_SDK_ROOT=/mnt/data/android-sdk npm run tauri -- android build --debug --target aarch64 --apk --ci`
- **Artifact (local, ignored/generated):**
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
  It is a debug APK, not a distributable release artifact.
- **Compile blockers addressed:** Android references to the desktop orb's unminimize/
  drag APIs are now desktop-gated. Android credential storage selects the
  Android-native Keystore-backed keyring provider rather than keyring's unsupported
  default v1 provider.
- **Not proved:** no emulator system image is installed and no physical device is
  attached. Install/start, JNI setup, Keystore persistence, credential round-trip,
  native SSH, IME, lifecycle, SSH host trust, agent exchange and terminal behavior
  remain untested on a running Android device. The AVD profiles alone are not evidence.

- [ ] **MOB-01.01** Inventory JDK, SDK, NDK, Rust targets, Tauri CLI/plugin versions
  and build dependencies; record a repeatable local setup.
- [ ] **MOB-01.02** Establish repository-owned Android configuration/templates or
  plugins; do not rely on untracked edits under ignored `src-tauri/gen/android/`.
- [x] **MOB-01.03** Compile the Rust/backend stack for Android and document native
  dependency failures, linker constraints and required conditional compilation.
- [ ] **MOB-01.04** Gate desktop window controls, orb/multiwindow setup, local PTY and
  unsupported clipboard/external-open paths so Android startup does not call them.
- [ ] **MOB-01.05** Produce and install an ARM64 development APK on a physical phone;
  verify real WebView-to-native IPC rather than the browser simulation adapter.
- [ ] **MOB-01.06** Open a real authenticated SSH connection with explicit first-use
  host trust and demonstrate a changed-key rejection.
- [ ] **MOB-01.07** Start/read one supported remote agent and send one prompt through
  the native bridge; record the exact provider/runtime version.
- [ ] **MOB-01.08** Prove an Android-supported credential-storage path across app
  restarts; do not substitute renderer local storage for the secure adapter.
- [ ] **MOB-01.09** Exercise xterm input, soft-keyboard composition, scrolling and text
  selection on the phone; identify any blocker before committing to its mobile UI.
- [ ] **MOB-01.10** Exercise background, foreground, rotation and process recreation;
  record what survives today versus what requires implementation.
- [ ] **MOB-01.11** Capture startup, memory and streaming/scroll responsiveness on the
  baseline device; use this evidence to set MOB-14 performance budgets.
- [ ] **MOB-01.12** Record a go/no-go report for the client stack and supported-device
  baseline, with logs/screenshots and unresolved native blockers.

## MOB-02 — Shared identity, catalog, history and ownership contract

Dependencies: MOB-D2/D3; MOB-01 evidence where native behavior affects the contract.
Coordinate with AG-10 and AG-12; do not create competing discovery/control protocols.
Acceptance: AND-A02–06/A16/A17.

- [ ] **MOB-02.01** Define stable server/account, project, conversation, execution and
  provider-session identities and their authorized relationships.
- [ ] **MOB-02.02** Define how verified host aliases/endpoints resolve to one account
  identity without bypassing host-key verification or merging different accounts.
- [ ] **MOB-02.03** Define listing/discovery schemas for both live and saved/ended
  conversations, including canonical folders and provider resume references.
- [ ] **MOB-02.04** Define the shared transcript/event schema and which historical
  user messages, configuration, outcomes and attachment references must be retained.
- [ ] **MOB-02.05** Define replay cursor, bounded page/snapshot, ordering, deduplication,
  gap detection and transition from catch-up into live updates.
- [ ] **MOB-02.06** Define request identity using conversation, execution/attempt,
  request kind and request ID; specify already-answered/expired behavior.
- [ ] **MOB-02.07** Define operation IDs, durable receipts, acknowledgement boundaries
  and reconciliation for prompt/answer/cancel/config/history mutations.
- [ ] **MOB-02.08** Define read-only observation versus mutating ownership and the
  per-conversation lease/epoch transfer protocol.
- [ ] **MOB-02.09** Define atomic catalog/metadata updates, expected revisions,
  conflict responses and deletion/tombstone handling.
- [ ] **MOB-02.10** Define remote/shared versus local-only fields: drafts, unfinished
  answers, pins/archive/read preferences, cache and uploaded/unuploaded files.
- [ ] **MOB-02.11** Define schema/protocol negotiation, unsupported feature responses
  and safe behavior for old workers and clients.
- [ ] **MOB-02.12** Specify migration consent, restart checkpoints, backups, validation,
  retention and rollback; exclude credentials and unsent private drafts.
- [ ] **MOB-02.13** Define truthful status/capability data and separate connectivity,
  worker lifecycle, active turn, pending request and confirmed outcome.
- [ ] **MOB-02.14** Define device registration, notification routing identifiers,
  revocation boundaries and minimal push envelope fields.
- [ ] **MOB-02.15** Define interaction with parent/child chats: a phone reader must
  not replace the parent coordinator or add another submission authority.
- [ ] **MOB-02.16** Review the contract with example payloads, error cases and tests
  for duplicate delivery, conflicting owners and account/project isolation.

## MOB-03 — Remote catalog, complete replay, native cache and migration

Dependencies: MOB-02; approved data-sharing policy. Acceptance: AND-A02/A03/A07/A16.

- [ ] **MOB-03.01** Implement account-private catalog storage with permissions,
  schema versioning, atomic writes and crash-safe concurrent updates.
- [ ] **MOB-03.02** Register projects and conversations by stable identity, preserving
  current canonical folder and account associations.
- [ ] **MOB-03.03** Register existing/new executions and confirmed provider-session
  IDs; keep saved/ended conversations discoverable after a worker exits.
- [ ] **MOB-03.04** Expose bounded authenticated SSH discovery without needing the
  phone to know execution IDs or enumerate arbitrary socket files first.
- [ ] **MOB-03.05** Persist complete required transcript history, including user
  messages and normalized request outcomes, rather than assuming replay is complete.
- [ ] **MOB-03.06** Implement cursor-based replay, snapshots/pagination, gap detection
  and a race-safe caught-up boundary before live events.
- [ ] **MOB-03.07** Preserve resumable provider references, supported configuration,
  Todo snapshots and uploaded attachment references without leaking device secrets.
- [ ] **MOB-03.08** Reconcile pending requests from authoritative state; do not invent
  recoverable form schemas when a historical journal intentionally omitted them.
- [ ] **MOB-03.09** Add native cache adapters for shared records and keep device-owned
  drafts/preferences/reading positions separate from remote updates.
- [ ] **MOB-03.10** Display cached/stale/current/sync-failure states and offline history
  without claiming the remote execution ended.
- [ ] **MOB-03.11** Add revision-aware metadata mutations and explain conflicts;
  do not silently clobber a newer title/project association from another device.
- [ ] **MOB-03.12** Implement explicit desktop continuity opt-in for selected remote
  accounts/projects and explain the destination/retention of shared history.
- [ ] **MOB-03.13** Back up current native history and build a versioned migration
  export excluding credentials, local-only drafts and unuploaded file contents.
- [ ] **MOB-03.14** Implement restart-safe import/merge with stable provenance and
  duplicate detection; retain native originals until verification succeeds.
- [ ] **MOB-03.15** Link existing live workers, saved provider sessions, attachment
  paths and tmux names without creating replacement executions or renamed sessions.
- [ ] **MOB-03.16** Handle incompatible workers/missing history with explicit
  read-only/needs-upgrade/recovery states and safe upgrade boundaries.
- [ ] **MOB-03.17** Ensure migrated/replayed historical outcomes do not generate new
  completion alerts; document archive and shared-deletion scope.
- [ ] **MOB-03.18** Verify fresh-phone discovery, desktop-offline replay, migration
  rerun/interruption, corrupted partial data and multiple-account isolation.

## MOB-04 — Observation, controller transfer and mutation fencing

Dependencies: MOB-02; coordinate protocol adoption with MOB-03. Acceptance:
AND-A03–06/A16/A17.

- [ ] **MOB-04.01** Implement non-destructive observer connections; reading from the
  phone must not invoke the legacy replace-owner attach behavior.
- [ ] **MOB-04.02** Support multiple readers with bounded fan-out/replay and explicit
  access checks per account/project/conversation.
- [ ] **MOB-04.03** Implement a server-authoritative controller lease and monotonically
  changing epoch for each conversation, not one global phone/desktop controller.
- [ ] **MOB-04.04** Implement explicit acquisition/transfer with expected owner/epoch
  and a deterministic result for simultaneous requests.
- [ ] **MOB-04.05** Fence prompt, answer, cancel, model/mode, revert/retry and close
  operations; reject stale/unauthorized controllers before provider side effects.
- [ ] **MOB-04.06** Persist operation receipts and reconcile acknowledgement loss so
  retries cannot duplicate a paid turn or apply a request twice.
- [ ] **MOB-04.07** Publish ownership changes to both devices and preserve unsent text
  when the former controller becomes a reader.
- [ ] **MOB-04.08** Reconnect as an observer and catch up before mutation; do not let
  an old desktop or phone reconnect automatically steal the lease back.
- [ ] **MOB-04.09** Define lease renewal/expiry during backgrounding, process death
  and network loss without cancelling remote execution.
- [ ] **MOB-04.10** Separate transport detach, stop-turn request and execution close;
  leaving a screen is never an implicit remote stop.
- [ ] **MOB-04.11** Revalidate pending requests on transfer and handle another device
  answering first, superseded requests and changed execution attempts.
- [ ] **MOB-04.12** Integrate parent/child queue/controller rules where present;
  parent supervision must survive a direct phone view of the child.
- [ ] **MOB-04.13** Negotiate legacy-worker behavior and prevent unsafe mixed-version
  takeover loops or unrequested restarts.
- [ ] **MOB-04.14** Verify observer coexistence, takeover races, stale writes, lost
  receipts, lease expiry and per-conversation/account boundaries with two clients.

## MOB-05 — Phone shell, routes, insets, Back and lifecycle

Dependencies: MOB-01; route/data interfaces from MOB-02. Acceptance:
AND-A07–09/A14/A15/A18.

- [ ] **MOB-05.01** Introduce explicit platform capabilities for desktop windows,
  local execution, credentials, pickers, clipboard, lifecycle and notifications.
- [ ] **MOB-05.02** Extract reusable agent/domain components while keeping provider
  state and persistence shared; preserve the current desktop entry and shell.
- [ ] **MOB-05.03** Make Android open the Threads surface directly, with no terminal
  creation or connection prerequisite hidden behind the Agents destination.
- [ ] **MOB-05.04** Implement typed root/detail routes with server/project/conversation
  identity, return location and validated notification entry.
- [ ] **MOB-05.05** Implement the approved floating three-destination dock; retain
  accessible inactive-icon names, selection state and touch targets.
- [ ] **MOB-05.06** Keep the dock off conversation, request, review and terminal detail
  screens; remove desktop window controls, frame/morph and device-preview chrome.
- [ ] **MOB-05.07** Handle system Back/IME dismissal, sheets, detail navigation and
  root exit; integrate predictive Back where supported without trapping gestures.
- [ ] **MOB-05.08** Apply real status/navigation/cutout/gesture and IME insets; verify
  composer/request/sheet actions remain reachable at all keyboard heights.
- [ ] **MOB-05.09** Support portrait, landscape, multi-window and compact-to-expanded
  resizing without resetting the active conversation or locking orientation.
- [ ] **MOB-05.10** Persist drafts, unfinished form answers, local picker references
  and navigation/scroll state through supported process-recreation paths.
- [ ] **MOB-05.11** Save incrementally through native persistence; do not depend on
  a final WebView unload/suspend event for durability.
- [ ] **MOB-05.12** Reconnect/catch up on foreground with bounded backoff, correct
  listener cleanup and no duplicate subscriptions or automatic prompt resend.
- [ ] **MOB-05.13** Render the local cached library promptly while connections restore;
  show offline/auth-needed/loading states without a full-app blocking spinner.
- [ ] **MOB-05.14** Implement accessible sheet focus trapping, focus return and
  scroll containment with the actual keyboard open.
- [ ] **MOB-05.15** Pause decorative effects when hidden; budget blur/canvases and
  provide reduced-motion/transparency and opaque fallback behavior.
- [ ] **MOB-05.16** Verify rotation, process reclaim, background/reopen, keyboard/back,
  multi-window, long titles and desktop regression routes on the native build.

## MOB-06 — Threads, search/project selection and new task

Dependencies: MOB-03/05; actual capabilities from AG-11. Acceptance:
AND-A02/A03/A07/A14/A18.

- [ ] **MOB-06.01** Transfer the accepted reference captures/font assets into the
  repository with licenses; remove all dependency on the sibling mockup/LAN preview.
- [ ] **MOB-06.02** Implement Bricolage display roles, Source Sans reading/UI roles,
  code monospace and shared mobile sizing/spacing tokens.
- [ ] **MOB-06.03** Build the low-overload Threads list with real data, quiet project
  metadata and no oversized hero, separate attention card or duplicate status footer.
- [ ] **MOB-06.04** Implement Recent and Needs you filters from normalized state;
  retain working/confirmed-outcome states inline without adding permanent dashboards.
- [ ] **MOB-06.05** Add readable/accessibly named request/status indicators; unknown,
  offline and unsupported are not successful completion states.
- [ ] **MOB-06.06** Implement search and the project-filter sheet, preserving query,
  selected account/project and list position on return from detail.
- [ ] **MOB-06.07** Add honest loading, empty library, no search results, stale cache,
  auth-needed and discovery-error states with recovery actions.
- [ ] **MOB-06.08** Add the compact outlined circled-plus New task pill on a transparent
  footer above the dock, with no connected-server summary box.
- [ ] **MOB-06.09** Require an explicit authenticated server/account and canonical
  project folder before preparing or submitting a new task.
- [ ] **MOB-06.10** Support adding a server/project from Agents without creating a
  terminal card; keep terminal and agent folder ownership independent.
- [ ] **MOB-06.11** Populate provider/model/mode/effort controls from negotiated data;
  explain unavailable options and never copy mockup models into production defaults.
- [ ] **MOB-06.12** Preserve new-task drafts while changing project/model, reading
  installation help, attaching context or leaving/reopening the screen.
- [ ] **MOB-06.13** Implement rename/pin/archive with the agreed local/shared scopes;
  distinguish archive from shared-history deletion.
- [ ] **MOB-06.14** Handle imported/ended/child conversations using their real identity
  and capabilities; do not hide them merely because no live worker is present.
- [ ] **MOB-06.15** Verify list filters, project/account isolation, search, creation,
  unsupported providers, large text and restored navigation with remote data.

## MOB-07 — Conversation, requests, Todos and truthful states

Dependencies: MOB-04/05/06. Acceptance: AND-A03–09/A14/A16/A18.

- [ ] **MOB-07.01** Implement the accepted quiet transcript and editorial typography:
  clear title/speakers, unboxed user prompt, readable response and compact context.
- [ ] **MOB-07.02** Keep execution, connectivity and controller status distinct; place
  server/project info in a reachable detail surface rather than repeated title rows.
- [ ] **MOB-07.03** Implement Continue here and reader/controller/submitting/unknown
  states using acknowledged ownership, not local visual toggles.
- [ ] **MOB-07.04** Reuse bounded Markdown/code/tool/message-parts rendering with safe
  links, useful code copy and sensible long-content expansion.
- [ ] **MOB-07.05** Preserve reading position during streaming/replay and implement
  Jump to latest; bound long transcript rendering without breaking selection.
- [ ] **MOB-07.06** Make soft-keyboard Enter insert a newline and Send submit; support
  composition, dictation, emoji and external-keyboard behavior without accidental sends.
- [ ] **MOB-07.07** Persist composer drafts incrementally; keep text/attachments after
  auth failures, rejected sends, ownership changes and unknown acknowledgements.
- [ ] **MOB-07.08** Implement touch model/mode/effort/command sheets with provider
  acknowledged values and serialized updates that never submit the draft.
- [ ] **MOB-07.09** Show pending-request attention inline/near the composer and open
  the exact request in a focused keyboard-safe screen.
- [ ] **MOB-07.10** Render supported question field/choice types, validation and optional
  comments without assuming every provider has the same request schema.
- [ ] **MOB-07.11** Render meaningful permission context and supported approval/rejection
  choices; never interpret a phone tap or notification open as blanket authorization.
- [ ] **MOB-07.12** Preserve unfinished request answers, prevent duplicate submission
  and present pending/error/unknown/reconciled receipts explicitly.
- [ ] **MOB-07.13** Revalidate execution/request identity before response; handle answered
  elsewhere, expired, superseded and unavailable requests without dropping local text.
- [ ] **MOB-07.14** Keep agent Todos read-only, expandable and capability-aware;
  progress count does not establish provider success or task execution completion.
- [ ] **MOB-07.15** Keep tool activity secondary and bounded, with expandable useful
  details; avoid rendering every token/tool event as another prominent card.
- [ ] **MOB-07.16** Keep Stop/cancel, disconnect, detach and execution close distinct;
  display requested cancellation until a confirmed remote outcome arrives.
- [ ] **MOB-07.17** Preserve existing capability-gated history actions where exposed,
  using the same fenced mutation path; do not add implicit file rollback.
- [ ] **MOB-07.18** Preserve supported parent/child navigation and return context;
  unavailable direct child chat must be explained rather than simulated.
- [ ] **MOB-07.19** Verify real streaming, requests, config changes, stale ownership,
  unknown submission, offline reading and large-history interaction on a phone.

## MOB-08 — Changed-file review and native attachments

Dependencies: MOB-05/07; AG-02a/04 contracts as used. Acceptance: AND-A07/A12/A14/A17.

- [ ] **MOB-08.01** Implement full-screen read-only unified diffs with file selection,
  previous/next navigation and preserved conversation return/draft state.
- [ ] **MOB-08.02** Keep conversation-reported edits separate from timestamped Git
  working-tree snapshots and explain incomplete/unavailable data.
- [ ] **MOB-08.03** Validate repository/project identity and permission before remote
  review queries; never reuse another account's cached diff as current data.
- [ ] **MOB-08.04** Support long paths, line wrapping, horizontal code scrolling,
  syntax colors, line numbers, renames and no-change states at phone widths.
- [ ] **MOB-08.05** Bound large diff/transcript rendering; represent binary, omitted,
  truncated or stale patches honestly instead of freezing or fabricating text.
- [ ] **MOB-08.06** Keep commit/push/PR/worktree/file-edit actions outside this release
  unless separately approved; read-only review must not mutate remote files.
- [ ] **MOB-08.07** Integrate Android system file/photo pickers without broad storage
  permission and document the native URI/grant path.
- [ ] **MOB-08.08** Persist usable grants or copy to bounded private temporary storage
  when required so selection survives supported recreation/background paths.
- [ ] **MOB-08.09** Apply per-file/count/total limits and readable validation for size,
  type, unreadable URI, revoked grant and cancelled selection.
- [ ] **MOB-08.10** Show attachment names/previews/progress with removable drafts;
  preserve the message if preparation/upload fails or the picker is cancelled.
- [ ] **MOB-08.11** Upload through authenticated remote access with stable references,
  duplicate protection and validation of destination account/folder/path.
- [ ] **MOB-08.12** Define interrupted-upload retry/cleanup behavior, including server
  space errors, partial files and private-device temporary-file retention.
- [ ] **MOB-08.13** Gate image understanding and remote-reference behavior by actual
  provider capabilities; a picker success is not proof of image support.
- [ ] **MOB-08.14** Verify system photo/file selection, loss of URI access, rotation,
  upload interruption, diff size limits and navigation back to the unchanged draft.

## MOB-09 — Server setup, pairing, registration and credentials

Dependencies: MOB-01/02; MOB-D5. Acceptance: AND-A02/A03/A16/A17.

- [ ] **MOB-09.01** Implement direct server add/connect with endpoint, SSH account,
  project choice, validation and actionable network/authentication errors.
- [ ] **MOB-09.02** Preserve first-use/changed-key trust flows and out-of-band
  fingerprint verification; reject a server that changes during confirmation.
- [ ] **MOB-09.03** Implement approved password/key/passphrase flows with secrets
  transiently handled by native code and never persisted by the WebView.
- [ ] **MOB-09.04** Implement Keystore-backed encryption for stored secret blobs,
  private file permissions, forget-key controls and backup exclusion.
- [ ] **MOB-09.05** Document supported SSH key formats, per-device-key provisioning
  and recovery if stored credentials become invalid or the device is replaced.
- [ ] **MOB-09.06** Implement the approved metadata-only pairing descriptor: server/
  account/project references, verified identity, protocol version and registration grant.
- [ ] **MOB-09.07** Reject expired, replayed, malformed, wrong-server and unsupported
  descriptors; never embed an SSH secret or silently accept changed host trust.
- [ ] **MOB-09.08** If a short-code flow was approved, implement its authenticated
  rendezvous/confirmation, rate limits and single-use expiry; otherwise omit it.
- [ ] **MOB-09.09** Register an independently authorized device identity and its
  notification/control scope; preference for separate SSH keys remains explicit.
- [ ] **MOB-09.10** Implement device unlink/revocation across controller grants and
  push registrations without claiming to revoke an unrelated SSH credential.
- [ ] **MOB-09.11** Explain cached-data removal and SSH-key revocation separately;
  offer safe local forget/unlink actions without deleting remote history implicitly.
- [ ] **MOB-09.12** Sanitize error/diagnostic output so credentials, grants, raw key
  content and sensitive request arguments cannot appear in logs/clipboard.
- [ ] **MOB-09.13** Verify trust races, revoked access, wrong-account pairing, secret
  persistence/forget, and desktop-offline reconnection on a physical phone.

## MOB-10 — Remote notification truth and durable outbox

Dependencies: MOB-02 and shared AG-01/05 semantics, not the orb UI.
Acceptance: AND-A10/A11/A16.

- [ ] **MOB-10.01** Inventory which notification-relevant reductions currently happen
  only in the native desktop parser and must be shared with the remote runtime.
- [ ] **MOB-10.02** Produce normalized needs-input, confirmed outcome and meaningful
  failure events independently of desktop/phone transport connections.
- [ ] **MOB-10.03** Keep active worker, active turn, completed Todo, terminal output
  and verified success distinct; unsupported outcomes remain unknown/unverified.
- [ ] **MOB-10.04** Define notification event IDs and a deduplication key scoped to
  conversation/execution/request or confirmed outcome.
- [ ] **MOB-10.05** Persist dispatch intent in an account-private crash-safe outbox;
  sending push must not block agent execution or provider response acknowledgements.
- [ ] **MOB-10.06** Implement bounded retry/backoff/expiry, duplicate suppression and
  recovery after notifier restart or relay unavailability.
- [ ] **MOB-10.07** Respect registered devices, notification categories and per-thread
  mute; do not send every token, tool change or parent-summary duplicate.
- [ ] **MOB-10.08** Mark obsolete/resolved requests and prevent stale outbox entries
  from presenting an answered question as a new permission request.
- [ ] **MOB-10.09** Suppress historical/migration/replay notifications and distinguish
  resume/recovery from a newly completed task.
- [ ] **MOB-10.10** Verify request/outcome emission with no connected client, relay
  outage/restart, duplicate dispatch and old-worker compatibility.
- [ ] **MOB-10.11** Establish the notifier/outbox lifetime and approved supervision
  policy so worker exit, notifier crash or server restart does not lose pending
  delivery; replay after restart must not produce duplicate historical alerts.

## MOB-11 — Push relay and native Android notifications

Dependencies: MOB-09/10 and an approved MOB-D4 deployment. Acceptance: AND-A10/A11/A17.

- [ ] **MOB-11.01** Record approved hosting/configuration, operator responsibility,
  secrets, retention, logging, cost and incident/revocation procedure before deployment.
- [ ] **MOB-11.02** Implement authenticated scoped registration/dispatch endpoints;
  prevent arbitrary device routing, cross-account dispatch and unbounded payloads.
- [ ] **MOB-11.03** Keep relay credentials/server signing material and FCM service
  credentials outside app bundles, repositories, QR descriptors and diagnostic output.
- [ ] **MOB-11.04** Implement minimal notification envelopes and rate limiting;
  no transcript/raw permission/file contents or SSH credentials in push payloads.
- [ ] **MOB-11.05** Implement FCM response handling, token replacement/retirement,
  bounded retry/expiry and scoped device/server revocation.
- [ ] **MOB-11.06** Integrate actual native FCM receipt with Tauri/Android; prove
  background receipt rather than relying on a local-notification API alone.
- [ ] **MOB-11.07** Register/refresh the device token through an authenticated path
  and reconcile rotation after reinstall, restore, app update or registration loss.
- [ ] **MOB-11.08** Add distinct attention, ready and failure notification channels
  with appropriate user-configurable importance and mute behavior.
- [ ] **MOB-11.09** Request Android notification permission contextually and support
  denial, dismissal, later enablement and recovery through system settings.
- [ ] **MOB-11.10** Default to discreet lock-screen copy and expose an explicit
  preview preference; honor OS/channel privacy settings.
- [ ] **MOB-11.11** Ensure notification actions only open/reconcile state; never
  auto-approve, retry a prompt or transfer control from an unvalidated intent.
- [ ] **MOB-11.12** Separate dispatch/receipt/open evidence from provider action
  acknowledgement and outcome; do not call an alert delivered merely because queued.
- [ ] **MOB-11.13** Document Google Play services coverage/non-GMS limitations and
  supported force-stop/Doze/OEM behavior without an absolute instant-delivery claim.
- [ ] **MOB-11.14** Verify locked/background/process-reclaimed receipt, permission
  denial/recovery, token rotation, revocation and relay outage on real devices.

## MOB-12 — Notification entry, exact routing and catch-up

Dependencies: MOB-03/04/05/11. Acceptance: AND-A06/A09–11/A17.

- [ ] **MOB-12.01** Define validated native intent-to-route conversion with known
  registration/server/account/conversation/execution/request scope.
- [ ] **MOB-12.02** Handle cold-start, warm-app and already-open-conversation taps
  through the same routing contract without duplicate screens or subscriptions.
- [ ] **MOB-12.03** Authenticate/re-establish trusted server access before reading or
  acting; notification routing must not bypass key trust or credential prompts.
- [ ] **MOB-12.04** Catch up authoritative history and pending-request state before
  presenting an answer/control action as currently available.
- [ ] **MOB-12.05** Open exact pending request/result, preserve parent/child context,
  and return to the correct library/project screen.
- [ ] **MOB-12.06** Handle answered/expired/superseded requests, replaced executions,
  missing workers and revoked devices with truthful recovery screens.
- [ ] **MOB-12.07** Support offline notification opening into cached history with a
  reconnect explanation; no blind queued answer or automatic resend.
- [ ] **MOB-12.08** Deduplicate repeated intents and keep device read/unread cursors
  separate from shared request outcomes and execution state.
- [ ] **MOB-12.09** Verify forged/stale/deep-linked identifiers, interrupted auth,
  duplicate taps and cold-start catch-up without any remote side effect from the tap.

## MOB-13 — Touch terminal and persistent tmux sessions

Dependencies: MOB-01/03/05. Acceptance: AND-A03/A07–09/A13/A14/A18.

- [ ] **MOB-13.01** Discover/show the existing remote terminal/tmux identities with
  server/project context; do not generate new sessions from display names on reopen.
- [ ] **MOB-13.02** Bind the real terminal to stable local/remote identity and native
  SSH events, preserving output across surface navigation.
- [ ] **MOB-13.03** Implement keyboard show/hide and a reachable Ctrl latch, Esc, Tab,
  arrow and paste toolbar with 48dp targets and overflow on small widths.
- [ ] **MOB-13.04** Implement soft-keyboard/IME input and external-keyboard shortcuts;
  terminal Enter sends terminal input, distinct from the conversation newline rule.
- [ ] **MOB-13.05** Implement touch history scrolling versus TUI mouse input and
  usable long-press text selection/copy without desktop shortcuts.
- [ ] **MOB-13.06** Implement explicit safe paste, handling multiline/bracketed paste,
  clipboard-denied states and warnings for potentially dangerous command content.
- [ ] **MOB-13.07** Fit keyboard/orientation/multi-window changes with coalesced
  terminal resizing, no dropped output and no connection/session replacement.
- [ ] **MOB-13.08** Implement the approved concurrent desktop/phone tmux viewport
  policy so an inactive phone does not repeatedly shrink desktop applications.
- [ ] **MOB-13.09** Expose readable text sizing and renderer fallback when WebGL is
  unavailable/lost; persist preferences without causing a reconnect.
- [ ] **MOB-13.10** Bound high-output history and pause invisible rendering without
  corrupting terminal state; verify long scrollback and sustained output.
- [ ] **MOB-13.11** Retain secure external-link handling, host-key/auth prompts and
  explicit Disconnect versus remote stop/close behavior.
- [ ] **MOB-13.12** Verify tmux reattach after app/process/network loss, Ctrl/Tab/arrows,
  selection/paste, landscape keyboard and physical keyboard on supported phones.

## MOB-14 — Security, accessibility, performance and resilience

Dependencies: MOB-06–13. Acceptance: AND-A04–18 as relevant; all release criteria
must have evidence, not only tests selected below.

- [ ] **MOB-14.01** Set measurable startup/cached-paint, catch-up, responsiveness,
  memory and background-energy budgets from MOB-01 before final hardening.
- [ ] **MOB-14.02** Test 320px compact, landscape, tablet/multi-window and 200% text
  scaling for clipped text, unreachable actions and unintended horizontal UI scroll.
- [ ] **MOB-14.03** Test TalkBack reading order, labels, focus return, pending-request
  announcements, active navigation and icon-only controls.
- [ ] **MOB-14.04** Check contrast, text roles, touch targets, reduced motion,
  reduced transparency, keyboard focus and visible errors across every screen/state.
- [ ] **MOB-14.05** Stress long titles/paths/messages, Unicode, emoji, RTL where
  supported, dense tool events, many conversations and large diffs.
- [ ] **MOB-14.06** Measure long-history streaming/scrolling on a mid-range device;
  fix unbounded DOM/output/cache, excessive blur/canvases and off-screen work.
- [ ] **MOB-14.07** Measure background energy and reconnection churn; no always-on
  SSH polling or wake-lock workaround may replace approved notification delivery.
- [ ] **MOB-14.08** Exercise Wi-Fi/cellular/VPN changes, DNS/alias differences,
  unreachable servers and interrupted upload/replay/configuration operations.
- [ ] **MOB-14.09** Exercise process reclaim, rotation, cold/warm start, storage pressure,
  damaged cache and native persistence failures with drafts/history present.
- [ ] **MOB-14.10** Test migration interruption/retry, old-worker negotiation,
  missing provider sessions and server/provider restarts without silent replacement.
- [ ] **MOB-14.11** Test stale epochs, simultaneous takeovers, duplicate receipts,
  already-answered permissions and cross-account/project identifiers adversarially.
- [ ] **MOB-14.12** Test untrusted IPC/intent/URL/attachment metadata, revoked grants,
  path traversal and sensitive data in errors, logs, backups and clipboard output.
- [ ] **MOB-14.13** Review permissions, Android network/CSP/capabilities, credential
  encryption/key lifecycle and device unlink/SSH-revocation boundaries.
- [ ] **MOB-14.14** Record provider/version-specific prompt, status, request, model,
  Todo, attachment and resume evidence for every capability advertised on the phone.
- [ ] **MOB-14.15** Run native/worker/domain and responsive UI regressions plus the
  existing desktop agent/terminal suites; fix any cross-platform regression.
- [ ] **MOB-14.16** Run emulator and physical-device matrices with Gboard/Samsung
  keyboard, hardware keyboard, gesture/button navigation, Doze and notification denial.
- [ ] **MOB-14.17** Review licenses, self-hosted fonts/assets and dependency/native
  platform support; document any unsupported device/provider restriction honestly.
- [ ] **MOB-14.18** Record acceptance evidence with app, worker/provider, OS, WebView,
  keyboard, device/network versions; identify unresolved release blockers explicitly.

## MOB-15 — Signed APK, clean build, upgrade and release documentation

Dependencies: MOB-14 and release sign-off. Acceptance: AND-A01–18.

- [ ] **MOB-15.01** Establish a clean-checkout CI/local build using tracked Android
  configuration, pinned dependencies and documented SDK/NDK/toolchain versions.
- [ ] **MOB-15.02** Create the approved release signing process and protect the
  signing key/passwords outside the repository; document ownership and recovery.
- [ ] **MOB-15.03** Set stable application identity/versioning, ARM64 packaging and
  supported minimum/target API policy; do not inherit scaffold defaults blindly.
- [ ] **MOB-15.04** Provide production/adaptive icons, app label and appropriate
  manifest/intent configuration; remove unwanted generated TV/debug affordances.
- [ ] **MOB-15.05** Verify release permissions, CSP/network rules and native capabilities;
  no preview endpoint, demo accounts, test keys, debug grants or mock data path ships.
- [ ] **MOB-15.06** Test signed install and install-over-update with existing history,
  drafts, registrations, secure credentials and terminal preferences.
- [ ] **MOB-15.07** Test schema upgrades/recovery and documented cache/credential backup,
  uninstall/reinstall and device-replacement expectations.
- [ ] **MOB-15.08** Verify production relay/native push configuration, token renewal
  after update, revocation and cold-start notification routes with the release APK.
- [ ] **MOB-15.09** Publish supported device/provider/runtime matrix and known limits,
  including Google services, force-stop/OEM delivery and remote-server availability.
- [ ] **MOB-15.10** Publish setup, host trust, pairing, per-device SSH credentials,
  continuity migration and device unlink/revocation instructions.
- [ ] **MOB-15.11** Publish troubleshooting for IME/terminal input, failed connections,
  unknown submission, cache recovery and notification-permission/channel problems.
- [ ] **MOB-15.12** Document safe diagnostic collection with secret/content redaction;
  include build/OS/WebView/provider identification for reproducible reports.
- [ ] **MOB-15.13** Complete security/accessibility/device review and record acceptance
  results, signed artifact identity and reproducible build reference.
- [ ] **MOB-15.14** Update current-behavior docs only for capabilities proven in the
  release; do not convert remaining spec targets into shipped guarantees.
- [ ] **MOB-15.15** Update AG-16/master status only after required acceptance passes;
  keep any explicitly deferred non-release work separate from unfinished requirements.

## Release acceptance checklist

Full pass conditions are in the plan's [acceptance matrix](android-mobile.md#10-acceptance-matrix).
Use these as release sign-off links; do not weaken the original criteria by replacing
them with the shorter labels below.

- [ ] **AND-A01** Clean signed build, installation and data-preserving upgrade.
- [ ] **AND-A02** Fresh-phone discovery of existing authenticated remote work.
- [ ] **AND-A03** Same conversation/provider session while desktop is powered off.
- [ ] **AND-A04** Coexisting readers and safe per-conversation explicit control transfer.
- [ ] **AND-A05** Lost acknowledgements/reconnect without duplicate paid turns.
- [ ] **AND-A06** Stale/already-answered request reconciliation across devices.
- [ ] **AND-A07** Draft/attachment/scroll preservation across Android lifecycle changes.
- [ ] **AND-A08** Real soft/hardware keyboard, composition, paste, Send and insets.
- [ ] **AND-A09** Network/VPN transitions without trust loss or execution cancellation.
- [ ] **AND-A10** Real locked/background alert and exact cold-start request/result route.
- [ ] **AND-A11** Permission/Doze/token/revocation/force-stop behavior and recovery.
- [ ] **AND-A12** Bounded review/attachments with distinct conversation/Git sources.
- [ ] **AND-A13** Touch terminal and unchanged tmux identity through reattach/resize.
- [ ] **AND-A14** Compact/adaptive layouts, large text, TalkBack and accessible controls.
- [ ] **AND-A15** Responsive long-history/streaming and acceptable background resource use.
- [ ] **AND-A16** Migration/version/cache/server failure without lost or replaced work.
- [ ] **AND-A17** Trust, auth, ownership and untrusted-intent/path security boundaries.
- [ ] **AND-A18** Existing desktop behavior and agent/terminal regressions preserved.

## Evidence record format

For each completed item, link or append:

```text
Task / acceptance ID:
Commit or build reference:
Checks run and result:
App / worker / provider versions:
Phone / Android / WebView / keyboard versions, when applicable:
Network / desktop-online-or-offline conditions:
Evidence / known limitations:
```

## Explicitly separate later work

Keep these outside the first-release completion count: iOS, Play Store launch,
non-GMS push if not approved, desktop-local execution access, a phone-local agent
runtime, overlay/orb UI, full Git delivery/worktrees, a full mobile IDE, scheduled
tasks and silent offline prompt queues. None can be silently substituted for a
required first-release continuity, safety or background-alert task.
