# Agent workspace: T3 Code review and revision plan

## Revision 3 — issue-by-issue remediation plan

**27 October 2026 · Approved by “Start!” · Implemented; target-device acceptance remains**

The user rejected the workspace shipped in `b7f6a24`: poor visual fidelity and rendering, missing local session history, an implicitly selected project, unintuitive navigation, cognitive overload, poor scrolling, weak animation, and incomplete OpenCode commands. The requested deliverable is an individually actionable plan, documented before further fixes. This revision is that plan; the implementation and test results below it are historical evidence, not acceptance of the rejected experience.

### Implementation record

- **Local persistence:** `src-tauri/src/agent_store.rs` writes versioned, per-conversation journals under `app_data_dir()/agents`. Received agent events are flushed before live delivery; draft/metadata writes are coalesced for 150ms with acknowledgement/error state. A process-wide writer, cross-process file lock, and per-conversation execution lease serialize ownership. Incomplete trailing appends are backed up and recovered; damaged complete records are reported. Checkpoints use flushed temporary files and replacement without deleting the old journal first. Stable local IDs and per-attempt sequences preserve history through resume. Deletion leaves a tombstone and removes the selected journal/recovery files.
- **Migration and lifecycle:** Valid WebView v1/v2 records migrate idempotently, including legacy resumed identities and draft/project metadata. Original cache data is removed only after successful migration and native readback; partial failures retain it. Native history is readable offline without terminal cards. Existing live workers are reconciled on WebView reload; saved conversations resume explicitly. Uncertain submissions remain unresolved across reload. Graceful window close flushes pending changes; save failures are visible in Agents and the main workspace.
- **Project choice and navigation:** Global Agents opens local Home without choosing a server. Global New is unassigned; project-scoped New shows the exact host/folder. A validated chooser supports existing servers and new agent-only server profiles; remote folders resolve with `pwd -P`. Renaming, pinning, archive/restore, deletion, project ordering/collapse, and per-project drafts remain available. Selecting a project for an unassigned idea transfers that draft only when it cannot overwrite an existing project draft.
- **Visual, rendering, motion:** Rebuilt charcoal/sage operating surface, more readable prose/controls, quiet context line, native-copy code blocks, supplied unified patch hunks with line context, ordinary saved state, and progressive disclosure. Stable message identities and frame-batched stream notifications reduce remounts. Popovers, disclosure, and explicit list moves have short transitions with reduced-motion support. Long history initially shows 120 activity items; older content is explicitly loadable, and message search covers the complete local transcript.
- **Scrolling:** Follow-end, sent-turn anchoring, and reader-controlled modes preserve message/offset across streaming, tool expansion, composer/window resizing, earlier-history loading, and conversation switches. Menus scroll within their own bounds; code uses horizontal overflow rather than nested capped vertical panes.
- **Commands:** OpenCode project discovery now runs before creating a provider session, retains skills, waits for scan updates, reports incomplete scans, and supports refresh. Skill choices insert `@skill-id` and use V2's typed skill attachments. `/reload` uses the configuration-reload API. The searchable palette includes verified Still actions, native server commands, skills, and an explicit inventory of known native-only actions with reasons. It does not claim universal plugin/TUI parity.

### OpenCode V2 compatibility evidence

Installed runtime: **2.0.29**. Its tagged source resolves to `042d0832f5f3a73eaa039a58a7d565776f6d4290`. Reviewed `packages/tui/src/app.tsx`, `routes/session/index.tsx`, `component/prompt/index.tsx`, `component/prompt/autocomplete.tsx`, and the built-in `feature-plugins` for side questions, plugins, stats, and diffs. This establishes why the server's `/api/command` response alone misses the native palette's actions.

| Source/action | Current handling | Evidence |
| --- | --- | --- |
| Global/project Markdown and nested server commands | Server-resolved registry; execute through `/api/session/{id}/command` | Real verified-SSH fixture includes `team/review`; protocol fixture covers 24 nested names and arguments |
| Skills | Retained `/api/skill` list; searchable `@id`, typed attachment on `/prompt` | Installed account exposed **31 skills**; real SSH discovered project skill `still-check`; protocol test verifies attachment ID/text |
| Pre-conversation catalogs | Dedicated discover-only OpenCode server, shut down after inventory | Installed-runtime request trace recorded **zero `POST /api/session` calls** |
| `/compact`, `/reload` | Explicit provider API routes unless the server already owns that name | Protocol lifecycle and refresh verification |
| `/new`, `/sessions` (`/resume`, `/continue`), `/open` (`/projects`, `/project`) | Still-local creation, search, project choice with scope described | Browser navigation/draft tests |
| `/models`, `/agents`, `/variants` (`/thinking`, `/effort`), `/skills` | Searchable advertised settings/skills | Provider catalogs and browser settings tests |
| `/rename`, `/copy`, `/timeline`, `/settings`, `/help` | Still-local actions, with local-history scope explicit | Metadata, native clipboard, and complete-transcript message search |
| `/clear`, `/undo`, `/redo`, `/editor`, `/btw`, `/highlights`, `/connect`, `/mcps`, `/plugins`, `/worktrees`, `/cd`, `/fork`, `/share`, `/export`, `/status`, `/debug`, `/stats`, `/diff`, `/themes`, `/pair` (`/web`), `/restart`, `/update`, `/exit` (`/quit`, `/q`) | Discoverable as native-only or not connected, with action-specific explanation | Tagged native registration source; never silently submitted as ordinary chat |
| Dynamic TUI plugin registrations | Remain a native-plugin boundary; server-owned plugin commands appear when advertised | V2 CLI plugin documentation; arbitrary user plugins are not claimed as enumerated |

The installed local project initially advertised `init` and `review`, plus 31 skills; Still also provides compact/reload routes. The full inventory is context/version dependent. Model listing and command discovery do not establish authentication or a successful model turn.

### Validation evidence and remaining target-device checks

- Latest checks: **35 agent browser cases** (34 in the full run plus the subsequent short-window case), **9 protocol cases**, **42 Rust unit cases**, **38 terminal browser cases**, and **5 terminal unit cases** passed. Build/typecheck, M3/M5/M6 regressions, presets, and `git diff --check` passed. The two opt-in Rust checks below were also run successfully. The user subsequently requested publishing Revision 3 and dispatching the Windows ARM64 packaging workflow; target-device acceptance remains separate from that build.
- Native journal tests cover incomplete trailing writes, replay deduplication across resumed attempts, corrupt complete records, checkpoints, and partial/idempotent legacy migration.
- An opt-in **real Tauri runtime** test under Xvfb exercised the resolved application-data directory, metadata/workspace save/readback, **1,500 flushed streaming events**, lease conflict, resume identity, and deletion. It uses its own temporary application identifier.
- The opt-in **verified SSH** provider-catalog check passed for Pi, Claude, Codex, and OpenCode, including the new pre-conversation nested-command/skill inventory. The separate real SSH-only test passed and confirmed no terminal/tmux creation.
- Browser fixture coverage now includes offline history with zero terminal cards, explicit project selection, project-owned drafts, resume/uncertain states, long-history paging/search, retained history when snapshots are shorter, anchored scrolling/text selection, reduced motion, native copy, and host verification. Fixture execution remains synthetic.
- A measured development-Chromium workload of **1,000 messages, 251 tools, and a 1,000-line patch** initially rendered in approximately **1,151ms**, with a **988ms** long task and a **228ms** Playwright input round trip. After paging and lazy tool detail, the comparable run rendered in **257ms**, with a **163ms** largest recorded long task, **18.3ms p95** animation-frame spacing during scripted scrolling, and a **27ms** input round trip. These are local observations, not Windows ARM64 guarantees or isolated keystroke latency measurements.
- Reviewed live fixture screenshots at 1100×720 and 620×700, including home, chat, command/skill picker, and tool activity; a 550×360 browser case verifies composer/approval reachability in a short/zoomed window. Visual acceptance still belongs to the user; packaged Windows WebView2, precision-trackpad behavior, reboot/update retention, and authenticated model turns require target-device verification. An ARM64 build alone does not prove those checks.

The original approved plan follows, preserving its acceptance criteria. Current implementation should be judged against the evidence above and the remaining target-device checks, not the earlier rebuild's pass counts.

### Outcome and working assumptions

Still should open into an understandable library of the user's projects and conversations. A user can read saved work immediately, deliberately choose where a new conversation runs, and follow the agent's work without fighting the interface.

- **Local means the computer running Still.** Its application-data directory owns durable conversation history, organization, drafts, and provider-resume references. Execution continues on the explicitly chosen SSH host. Saving locally and successfully resuming a remote provider are separate operations.
- **T3 Code remains the selected reference:** <https://github.com/pingdotgg/t3code>, pinned for this review to `28df7a246f9f7063180f9a4c509ee17c6823b32b`. Its information hierarchy and interaction behavior matter as much as its colors. The current imitation is not the visual authority.
- **A project is an explicit execution context:** host/account plus canonical remote folder. A terminal card, connection, current working directory, and conversation are different things; the interface should make their relationship clear through placement and labels.
- **The first viewport has one clear next action.** Existing work is available from the sidebar; new work starts with an explicit project choice. The active conversation gives priority to readable output and the composer.
- This is a source-based audit informed by the user's real-use report. The exact history-loss incident, target-machine performance, and full installed OpenCode inventory still need reproduction. Source findings below identify real defects and gaps without claiming those runtime investigations are complete.

### Execution order

| Step | Problem | Required result |
| --- | --- | --- |
| 1 | Local session persistence | Durable native history, readable offline and after restarts/upgrades |
| 2 | Automatic project selection | Deliberate host/folder selection with no implicit main project |
| 3 | Unintuitive navigation | Predictable home → project → conversation flow |
| 4 | Cognitive overload | Quiet default controls with discoverable secondary actions |
| 5 | Missing OpenCode commands | Verified, searchable inventory with correct execution routes |
| 6 | Visual fidelity and rendering | T3-referenced layouts and a legible, stable rich transcript |
| 7 | Poor scrolling | Reader-owned position, reliable following, smooth native input |
| 8 | Weak motion | Fast, purposeful transitions integrated with stable layout |

Implement in this order after approval. Each step has its own acceptance evidence; motion is applied after layout and scrolling behavior are stable. The visual state review in step 6 happens before replacing the UI, using the navigation and control decisions from steps 2–4.

### 1. Save conversations durably on the local machine

**Observed:** `src/session/agentThreads.ts` serializes the conversation index into WebView `localStorage` (`still.agents.index.v2`). This is local device storage, so it would be inaccurate to say nothing is saved locally. However, there is no native conversation store. Writes serialize the entire collection synchronously, assistant/reasoning chunks do not trigger persistence, restore errors are swallowed, and restored conversations are marked `error`. `src-tauri/src/agent.rs` retains only 1,200 history entries in a live snapshot. A snapshot refresh can therefore be a smaller source than the history already received. Navigation also filters the library through the selected host, which can make retained conversations appear missing.

**Planned work:**

1. Give the native Rust layer ownership of a versioned store under Tauri's resolved `app_data_dir()/agents/`. Keep the application identifier stable across packaged upgrades and expose the actual storage location in settings. Use the existing Rust filesystem, Tokio, and Serde facilities: small recoverable metadata plus per-conversation append records/checkpoints. The storage change does not require copying T3's database stack or adding a dependency.
2. Preserve a stable local conversation ID across provider processes/resumes. Persist host/account, canonical project path, provider and provider-session reference, execution-attempt IDs, ordered events, title, timestamps, archive/pin/order, and drafts. Use attempt ID plus event sequence to prevent replay duplicates. Retain complete saved history when a live snapshot contains only its tail.
3. Write ordered events off the renderer thread. Serialize writes through one native owner; checkpoint using flushed temporary files and platform-correct replacement. Define acknowledgements so “Saved on this device” means durable acknowledgement, not an optimistic state update. Any batching window must be bounded and visible as pending saves; flush at turn boundaries and clean shutdown.
4. Recover an incomplete final append without discarding preceding records. Surface read/write failures, retain the damaged original for recovery, and avoid replacing existing history with an empty library. Preserve deletion tombstones. Stored approvals/questions are historical records; live request handles and credentials are excluded from persistence.
5. Migrate valid v1/v2 WebView records and workspace preferences once, idempotently. Validate records independently, report partial failures, verify the native write, and retain the old data until migration succeeds. Do not discard the existing cache first.
6. Load the local library before SSH/authentication. Use readable states such as Saved, Working, Needs input, Interrupted, and Unavailable on server. An unavailable provider session leaves the saved transcript readable. Removing a terminal card must not hide or erase local agent history.

**Acceptance:** On the packaged app, create conversations across two hosts and two projects; include long output, a draft, renamed/pinned/archived items, and a resumed provider session. Quit/relaunch, restart the machine, and install an updated build: the same records remain. Read them with the network unavailable. Force-close during streaming and verify all acknowledged events survive without duplicate turns. Exercise failed writes, damaged final records, migration reruns, and a native snapshot shorter than the saved transcript. Confirm deletion removes Still's selected records without deleting project files, tmux sessions, or provider-owned history.

**Primary files:** `src/session/agentThreads.ts`, `src/agents/workspace.ts`, `src/bridge/nativeBridge.ts`, `src/bridge/tauriBridge.ts`, `src-tauri/src/agent.rs`, and a small native persistence module registered through `src-tauri/src/lib.rs`.

### 2. Remove implicit project and server selection

**Observed:** The global Agents button in `src/screens/Workspace.tsx` picks the first connected terminal session, otherwise `store.sessions[0]`; it is disabled when there are no terminal cards. `AgentWorkspace` passes `session.workingDirectory` to `readWorkspace`, which inserts that folder (or `~`) into the project list. Global New also inherits `prefs.folder`. This is a concrete path from terminal context to an unintended default agent project.

**Planned work:**

1. Make global Agents entry open a local home/library with no implicitly active project. Show recent/pinned projects and conversations as choices. Saved history remains accessible even with no terminal cards.
2. Make global New start an unassigned local draft with a visible “Choose project” action. A new conversation inside an explicitly selected project may inherit that project; its host and path remain visible at the composer. A terminal card's Agents action may intentionally scope the server, but its terminal directory is only a suggestion to confirm.
3. Represent unselected project state explicitly. Neither `~`, the first project, the connected terminal, nor a last-used folder silently becomes the target. Recently used folders are suggestions, not checked selections.
4. Resolve and validate a chosen folder on the chosen host before first execution. Project identity includes host/account and canonical full path; equal folder names on different hosts remain distinct. A saved conversation retains its original target.
5. Replace the single global new-thread draft with explicitly owned draft context so changing projects does not move unsent text to another host unnoticed. The first send creates a provider conversation only after the target is known.

**Acceptance:** Fresh install, cold launch, zero terminal cards, several connected cards, archived-only history, and two hosts with the same folder name all open predictably. Opening Agents creates no project or remote conversation. Global New has no target until chosen; project-scoped New has the visibly chosen target. Switching projects preserves each draft and never sends it to a different host accidentally. Terminal starting directories remain independent.

**Primary files:** `src/screens/Workspace.tsx`, `src/components/RemoteAgentWorkspace.tsx`, `src/components/AgentWorkspace.tsx`, `src/components/AgentConnection.tsx`, `src/agents/workspace.ts`.

### 3. Make navigation intuitive

**Observed:** `AgentWorkspace` combines a host-scoped sidebar, folder menus, setup, transcript, command overlays, archive view, and composer using many independent booleans. There is no neutral Agents home. Folder collapse, creating a conversation, changing its target, and setup compete for attention; the global entry also makes the host choice on the user's behalf.

**Planned work:**

- Define three explicit navigation states: **Home**, **Project**, **Conversation**. Home offers recent work and a clear New conversation action; Project shows its full host/path and conversations; Conversation shows its title and a stable breadcrumb back to the project.
- Keep one project/conversation sidebar and one main working area. Project names navigate, chevrons collapse, and a labelled contextual New action starts work in that project. Context menus contain management actions rather than hiding primary navigation.
- Treat adding a project as a short chooser: server → remote folder → confirm. Agent/model selection sits with the composer. New messages, saved-history reading, and setup failures each have a clear next action.
- Keep authentication in the explicitly selected connection flow. Offline reading is immediately available; connecting or resuming shows status without replacing the transcript with setup content.
- Give overlays consistent dismissal and focus return. Escape closes the topmost picker/dialog first. Keyboard users can reach navigation, menus, composer, and confirmation actions in a predictable order. On narrower windows the sidebar becomes a deliberate toggle rather than squeezing the reading column.
- Use “conversation” in user-facing labels. Reserve connection, provider session, and execution attempt for details where those distinctions help recovery.

**Acceptance:** Walk through first conversation, reopen saved conversation, switch project, change model, use a command, respond to a question, recover a disconnected conversation, rename/archive/restore, and confirmed deletion. Each flow works by pointer and keyboard, with visible destination context and no terminal detour. Back/navigation does not lose drafts, close active work, or strand focus behind an overlay.

**Primary files:** `src/components/AgentWorkspace.tsx`, `src/components/RemoteAgentWorkspace.tsx`, `src/components/AgentConnection.tsx`, `src/components/AgentControls.tsx`.

### 4. Reduce cognitive overload

**Observed:** The current composer exposes every returned configuration field; status, folder, provider, setup controls, plan, tool details, and banners can appear together. Restored history is styled as an error. Small controls and repeated context make it harder to distinguish the next action from supporting information.

**Planned work:**

- Define the resting conversation controls as message input, Send/Stop, and one compact agent/model control. Show project context once in the composer/header hierarchy; keep it inspectable without repeating the same path throughout the screen.
- Put reasoning level, permissions policy, executable overrides, and connection diagnostics behind clearly labelled contextual controls. Their current values remain discoverable; a provider-specific setting appears only when supported.
- Present completed tool activity as concise action/path/status rows. Group consecutive related tool work while preserving chronology; expand for output, inputs, and changes. Keep approval requests, questions, and actionable failures visible without making every event a card.
- Give the next required action visual priority: an approval or question when blocked; Stop while working; Send when ready. Keep connection state and save state separate and quiet when healthy.
- Make errors local to the failed action, with a usable retry/recovery action and expandable details. Saved/offline is an ordinary state, not a red failure banner. Setup and onboarding copy should disappear once the user has a usable context.

**Acceptance:** Review empty, idle, working, tool-heavy, approval, question, disconnected, and restored states using realistic content. The task, execution destination, and next action are clear in each. Secondary settings remain keyboard/search accessible. Important provider state is not hidden merely to make a screenshot cleaner.

**Primary files:** `src/components/AgentWorkspace.tsx`, `src/components/AgentControls.tsx`, `src/components/AgentTimeline.tsx`, `src/styles/agent-workspace.css`.

### 5. Account for missing OpenCode commands correctly

**Observed:** `OpenCodeDriver.readCatalog()` requests command, model, agent, and skill lists but destructures only the first three results: the skill inventory is discarded. Its command list uses `/api/command` plus a special case for `compact`. Before a conversation exists, the workspace has no current thread catalog to display. OpenCode's native slash menu/command palette also includes client actions and plugin registrations; the server command endpoint alone is not proof of complete TUI parity. The earlier 12-fixture-command check covered only a small server inventory.

**Planned work:**

1. Capture the installed runtime's version, explicit executable, effective account/configuration environment, canonical project location, server command/skill lists, native `/` menu, and Ctrl+P actions on the same host. Record the user's missing commands in a compatibility table: exact name, source, context, execution route, support status, and evidence. A documentation list alone is insufficient.
2. Load project catalogs independently of starting a conversation. Keep workspace actions available at Home; selecting a project triggers its inventory. Cache by host/account, folder, runtime/version, and configuration context. Report loading, refresh failures, and stale results honestly; refresh on relevant discovery/configuration events.
3. Use the server's resolved command registry for global/project Markdown, nested names, JSON/JSONC commands, and supported plugin-defined server commands. Preserve source metadata when provided. Verify collisions and scan timing instead of flattening names or treating a nonempty partial response as complete.
4. Retain the skill response and expose available skills in search with their actual identity and description. Skills are not automatically slash-command aliases: invoke them only using the installed version's supported mechanism and preserve their input semantics.
5. Provide explicit routes for client actions whose semantics Still implements, such as opening model/agent selection or starting a new conversation. Validate `/sessions`, `/undo`, `/redo`, `/editor`, `/btw`, and other observed actions against the installed runtime before presenting them as enabled equivalents. Conversation/history scope must match the action's advertised meaning.
6. Preserve known TUI-only/plugin-only actions in the compatibility inventory with a specific explanation when the server cannot expose or execute them. Dynamic plugin registrations may require inspecting the native registry; do not invent a complete list. Never pass an unsupported command through as ordinary chat text or run arbitrary terminal commands as a guessed substitute.
7. Use one searchable entry point from `/` and an accessible command action. Search exact names, aliases, and descriptions, preserve nested names and argument hints, and keep the highlighted row in view. Surface availability/reason details only where relevant. Discovery must work before the first message and update when the project changes.

**Acceptance:** Compare name sets against the actual installed CLI, not just a fixture count. Cover global, project, nested, JSON-configured, skill, server-plugin, and TUI-plugin cases; late scans; name collisions; refresh failure; and project switching. Exercise representative supported routes, arguments, returned forms, and command completion without a model turn. Every observed missing entry is either usable through a verified route or explicitly accounted for. Record authenticated inference results separately from discovery success.

**Primary files:** `src-tauri/agent-host/bridge.mjs`, `src-tauri/src/agent.rs`, `src/agents/types.ts`, `src/session/agentDiscovery.ts`, `src/components/AgentControls.tsx`, `src/components/AgentWorkspace.tsx`, `tests-agents/`.

### 6. Rebuild visual fidelity and transcript rendering

**Observed:** The workspace is predominantly 13px UI with much smaller secondary controls. `AgentMessage.tsx` provides basic Markdown/GFM containers but little code-block affordance; diffs are mostly raw patches or before/after blocks. `AgentTimeline.tsx` presents independent disclosure rows, and the transcript projection plus Markdown tree are rebuilt as stream data changes. These are implementation facts; the visual-quality judgement comes from the user's rejection, not from the previous automated pass.

**Planned work:**

- First review a coherent set of states against T3: local Home, new draft/project chooser, ordinary conversation, long code/diff, working tool group, approval/question, model/command picker, and saved/offline conversation. Use representative content at the app's 1100×720 default and a 1366×768 laptop viewport. This review establishes layout before a broad UI replacement.
- Build a quiet charcoal surface hierarchy with the existing Geist/Geist Mono fonts. Distinguish navigation, reading area, and composer by calibrated spacing and surface contrast. Proposed sizing to validate: roughly 240–280px collapsible sidebar, 14px controls, 15–16px prose, 12–13px code, and a roughly 740–800px reading column with a wider inspection view where needed. These are review targets, not a frozen reproduction of the rejected layout.
- Make selected conversation, active project, primary action, disabled state, and keyboard focus visually distinct. Give controls comfortable hit areas and tooltips/accessibility labels. Long titles and paths truncate with an accessible full value; content and actions remain usable under zoom.
- Reuse `react-markdown` and `remark-gfm`. Tune paragraphs, lists, headings, inline code, links, tables, and quotes as one reading system. Code blocks receive language labels when supplied, Copy feedback, preserved whitespace, and controlled horizontal overflow. Streaming partial Markdown must not cause repeated container remounts or reset text selection.
- Render real unified patch hunks with clear addition/removal treatment and file/line context when supplied. When the provider gives only before/after text, label that honestly. Keep large output and detailed changes behind useful disclosure, with complete content reachable. Unsupported media should have an explicit fallback rather than silently vanishing.
- Keep stable message/tool identities, reuse completed message renders, and batch visual updates for the actively streaming content. Measure large transcripts before adding windowing; any later windowing must preserve selection, search, focus, and scroll anchors.

**Acceptance:** Compare the same realistic state set side by side with the pinned T3 reference at default, laptop, narrow, and zoomed sizes. Inspect actual packaged Windows WebView2 rendering, not only Chromium fixture screenshots. Verify Markdown, code copy, long tables/paths, tool groups, diff content, and partial streaming syntax. Record render/input timings on a long conversation. Visual acceptance requires a user-facing review of these states; a passing build does not establish it.

**Primary files:** `src/components/AgentWorkspace.tsx`, `src/components/AgentMessage.tsx`, `src/components/AgentTimeline.tsx`, `src/agents/transcript.ts`, `src/styles/agent-workspace.css`.

### 7. Give scrolling back to the reader

**Observed:** `AgentWorkspace` resets following on conversation selection and writes `scrollTop = scrollHeight` on sequence changes. It has a near-bottom check but no explicit sent-turn anchoring, stored reader position, or resize-driven anchor correction. Growing code, expanded tools, composer resizing, and restored history therefore need stronger handling than the existing single streaming-scroll fixture demonstrates. Rendering and synchronous persistence are also plausible contributors to jank and need measurement.

**Planned work:**

1. Use three deliberate modes, informed by T3's controller: following the end, anchoring a newly sent turn, and free reading. Wheel, trackpad, scrollbar drag, touch, and keyboard navigation express reader intent; later chunks must respect it.
2. Preserve the first visible stable item and its pixel offset while earlier content grows, history loads, or a tool/diff expands. Observe relevant size changes, coordinate measurement with rendering, and avoid competing scroll writes.
3. Remember position per conversation. Returning to a conversation restores its reading position; an explicit Latest activity action returns to the end and resumes following. Distinguish initial opening, restored reading position, and user-sent turn behavior.
4. Give the transcript one main vertical scroller and the sidebar its own. Keep ordinary code/tables horizontally scrollable without stealing vertical wheel input. Large detail views have obvious boundaries and expansion controls; menu scrolling should not move the page behind them.
5. Use native input behavior. Batch follow corrections once per frame; reserve smooth scroll for deliberate short navigation, honour reduced-motion preferences, and avoid starting a new animated scroll for every token. Keep the composer and approval controls reachable as content changes.

**Acceptance:** Read older content during fast streaming; select/copy text; drag the scrollbar; use PageUp/PageDown/Home/End outside editable controls; expand a tool above the viewport; resize the composer/window; and switch conversations away and back. The anchored item should stay within a small recorded pixel tolerance and selection/focus should survive. Stress with 1,000 messages, hundreds of tools, and a large diff. Profile scroll-linked work for avoidable long tasks and review mouse-wheel plus precision-trackpad behavior on Windows ARM64. Record measurements rather than declaring scrolling smooth from one screenshot.

**Primary files:** `src/components/AgentWorkspace.tsx`, `src/components/AgentTimeline.tsx`, `src/styles/agent-workspace.css`, `tests-agents/workspace.spec.ts`; extract only the shared scroll logic that the behavior actually requires.

### 8. Add purposeful, polished motion

**Observed:** The existing stylesheet mainly supplies short color transitions and a working-status pulse. It has no coherent choreography for navigation, popovers, disclosure, or conversation-list changes. Animation must support orientation and feedback while preserving the scrolling guarantees above.

**Planned motion specification:**

| Interaction | Proposed behavior |
| --- | --- |
| Hover, press, focus feedback | Immediate response with approximately 100–140ms color/opacity transitions |
| Menu, model/command picker, small dialog | Approximately 140–180ms fade and small positional settle; focus moves promptly |
| Sidebar reveal and explicit navigation | Approximately 180–220ms restrained transition with stable content geometry |
| Expand tool/output details | Short measured disclosure, coordinated with the scroll anchor |
| Rename, pin, archive, explicit ordering | Approximately 150ms positional feedback where helpful; preserve the selected row |
| Working → needs input/completed/failed | Local status transition with text/icon feedback tied to real events |

Use CSS and the platform animation APIs already available. Animate opacity/transform where possible; coordinate necessary size transitions with measurement. Streamed text remains directly readable rather than receiving per-token entrance effects. Cancel superseded transitions during rapid navigation. Reduced-motion mode preserves instant state changes and all feedback without travelling/size animation. Announce meaningful status changes accessibly, not every token.

**Acceptance:** Review short recordings of the same state changes with normal and reduced motion. Rapidly open/close menus, switch conversations, expand output during streaming, and archive/restore. Motion must not delay typing, move the reader, lose focus, replay on unrelated updates, or imply completion before the provider reports it. Verify on the packaged ARM64 build as well as the browser fixture.

**Primary files:** `src/styles/agent-workspace.css`, `src/components/AgentWorkspace.tsx`, `src/components/AgentControls.tsx`, `src/components/AgentTimeline.tsx`.

### Evidence required before calling the revision complete

- **Persistence:** Native files and recorded restart/upgrade/offline/recovery results, including migration of existing data and retained acknowledged stream output.
- **Context and navigation:** Demonstrated global Home and explicit project choice; no automatic main folder; usable saved history without terminal cards; successful draft-preserving navigation.
- **Commands:** Installed-runtime compatibility inventory and representative execution evidence, including previously missing names. Server inventory, TUI actions, skills, and plugin behavior each have a verified explanation.
- **Visual and interaction quality:** Reviewed screenshots and short recordings of realistic states, scroll/input measurements, keyboard/zoom/reduced-motion checks, and packaged Windows ARM64 observation.
- **Regression coverage:** Relevant agent browser/protocol/native tests, typecheck/build, and terminal/connection regressions for shared changes. Report provider-authentication or runtime gaps separately from fixture passes. An ARM64 compile/package workflow proves packaging, not the interaction results above.

### Reference material and open evidence

T3 source reviewed at the pinned revision:

- [`DatabaseStorage.ts`](https://github.com/pingdotgg/t3code/blob/28df7a246f9f7063180f9a4c509ee17c6823b32b/apps/server/src/persistence/DatabaseStorage.ts): native/server-owned durable state rather than treating a renderer cache as the history authority.
- [`useHandleNewThread.ts`](https://github.com/pingdotgg/t3code/blob/28df7a246f9f7063180f9a4c509ee17c6823b32b/apps/web/src/hooks/useHandleNewThread.ts): explicit context handling for new work. Still's no-implicit-project behavior is a user requirement, not an assertion that every T3 default should be copied.
- [`timelineScrollAnchoring.ts`](https://github.com/pingdotgg/t3code/blob/28df7a246f9f7063180f9a4c509ee17c6823b32b/apps/web/src/components/chat/timelineScrollAnchoring.ts) and [`pageScrollController.ts`](https://github.com/pingdotgg/t3code/blob/28df7a246f9f7063180f9a4c509ee17c6823b32b/apps/web/src/components/chat/pageScrollController.ts): separate reading/following/turn anchoring and deliberate keyboard scrolling.
- [`ChatMarkdown.tsx`](https://github.com/pingdotgg/t3code/blob/28df7a246f9f7063180f9a4c509ee17c6823b32b/apps/web/src/components/ChatMarkdown.tsx), [`ChatComposer.tsx`](https://github.com/pingdotgg/t3code/blob/28df7a246f9f7063180f9a4c509ee17c6823b32b/apps/web/src/components/chat/ChatComposer.tsx), and [`Sidebar.motion.ts`](https://github.com/pingdotgg/t3code/blob/28df7a246f9f7063180f9a4c509ee17c6823b32b/apps/web/src/components/Sidebar.motion.ts): transcript/composer boundaries and measured, reduced-motion-aware list movement. Preserve MIT attribution for any adapted source.

OpenCode V2 documentation reviewed: [commands](https://opencode.ai/v2/docs/commands/), [skills](https://opencode.ai/v2/docs/skills/), [TUI actions](https://opencode.ai/v2/docs/cli/tui/), [CLI plugin registrations](https://opencode.ai/v2/docs/build/plugins/cli/), and [HTTP API](https://opencode.ai/v2/docs/api/). The installed target version remains the final compatibility check.

Open evidence to collect during the approved work: the user's exact missing-history reproduction, complete command inventory on their selected host/project, and Windows ARM64 recordings/performance traces. These are validation tasks, not reasons to silently declare the current implementation satisfactory.

---

The following sections describe earlier revisions. Their requirements remain useful context, but their completion claims do not supersede the Revision 3 acceptance criteria.

## Revision 2 — user-reported failures and accepted direction

The first shipped rebuild was rejected after real use. Passing the build and simulated browser checks did not establish provider compatibility or usability. The exact reference is **https://github.com/pingdotgg/t3code**, reviewed at `28df7a246f9f7063180f9a4c509ee17c6823b32b` (26 October 2026). This reference supersedes the earlier execution-list/modal direction below.

### Required experience

- Agents opens the agent workspace on the first click, including after a cold launch. Authentication and host-key decisions happen in that flow. Opening a terminal is an explicit action.
- Discover actual `pi`, `claude`, `codex`, `opencode`, and `gemini` installations automatically after SSH is available. Installation, runtime compatibility, and sign-in are different states. Cached discovery may render immediately while being refreshed.
- Use native provider interfaces where ACP does not expose the installed CLI's features: Pi RPC, Codex App Server, Claude structured streaming/control, OpenCode server API. Gemini retains native ACP. Integration dependencies must be explicit; no automatic package installation or invented capabilities.
- One project-oriented sidebar: server/account + resolved project folder → conversations, regardless of agent. Search, folder collapse, recent/name/manual ordering, rename, pin, archive/restore with Undo, and deletion. Streaming must not continually reorder the sidebar.
- Conversation identity and saved metadata are independent of a transient process. Deletion removes Still's history and stops its attached runner, never project files or terminal sessions. Provider-owned history remains independent and is described accurately.
- A restrained T3-like coding surface: compact project navigation, quiet header, readable conversation, one composer, a compact agent/model picker, contextual secondary settings. Setup and diagnostics appear on demand. No decorative hero or install dashboard as the everyday chat screen.
- Discover the complete provider-exposed command inventory in the actual remote project. OpenCode commands must use its command API, preserving arguments and command metadata. TUI-only commands require real Still equivalents rather than pretending to execute. Search and keyboard navigation have no three-item limit.
- Parse structured tools by stable ID and lifecycle, including input/output, file locations, commands, exit status, supplied edits, plans, permissions, and errors. Routine work may be grouped; failures and approvals stay visible. Unknown events use an honest fallback.
- Agent project directory, new-terminal startup directory, and an existing tmux pane's current directory are separate. Reopening a terminal must not inject `cd`, recreate a pane, or adopt the chat's folder.

### Implementation sequence and evidence

1. **Implemented locally:** persistent conversation metadata and folder organisation; rename/pin/archive/restore/delete; manual folder/thread ordering; independent SSH-only agent connection; automatic cached base-CLI discovery.
2. **Implemented locally:** bundled, dependency-free Node driver host using the installed Pi RPC, Claude structured streaming/control, Codex App Server, and OpenCode v2 HTTP interfaces. No `pi-acp`, `codex-acp`, or `claude-agent-acp` installation is required. Node.js 20+ is an explicit execution-host requirement; Gemini uses ACP directly.
3. **Implemented locally:** T3-informed project/chat surface, contextual settings, searchable model/command pickers, structured tool summaries and supplied diffs, questions/approvals, standard markdown/GFM rendering. The agent screen is lazy-loaded so its markdown dependencies do not block the terminal workspace.
4. **Verified locally:** 8 subprocess/protocol cases (including repeated cancellation, compaction and commands with pending forms) and 19 browser cases, including the actual workspace's cold Agents entry, explicit host-key decisions, startup/navigation races, folder lifecycle, command inventory, save failures, resumed history, unsafe markdown, and small-window keyboard flows. Rust unit checks and two opt-in real SSH tests also pass. Build and existing regression/preset checks pass.
5. **Not yet verified end-to-end:** successful inference and tool execution with the user's authenticated remote accounts, desktop Windows runtime, loss-of-SSH recovery, and full native/TUI feature parity. No ARM64 workflow has been triggered for this revision yet.

### Actual installation/transport evidence

The available local execution host has Pi `1.4.0`, Claude Code `2.1.239`, Codex CLI `0.160.1`, and OpenCode `2.0.29`. All four returned session identities and model/configuration catalogs through the bundled bridge, both as subprocesses and through the actual verified russh SSH transport. The real SSH-only test reached Live with an invalid terminal-start directory and verified that no saved tmux session was created. These are startup/transport checks, **not** successful model turns.

OpenCode's first directory read can precede its background scan. The bridge subscribes before reading, waits for directory-scoped `command.updated` and `skill.updated` when the inventory is empty, then rereads. With 12 nested `.opencode/commands/team/test-*.md` commands in an isolated test directory, the real installed runtime returned all 12 plus its 3 built-ins. The bridge invokes commands through `session.command`; it does not silently submit unknown commands as prose.

One bounded, no-tools inference smoke request was attempted for each installed provider. Pi returned a provider-credit/max-token error; Claude reported it was not signed in; Codex reported that the configured `OPENAI_API_KEY` was missing; OpenCode did not settle within 65 seconds. No account settings, credentials, provider defaults, or project files were changed to bypass those failures. Authentication/configuration readiness remains distinct from executable detection. Provider retry notices are shown rather than being mistaken for completed work.

The earlier terminal run had one failing zoom geometry assertion. On 27 October 2026, the current terminal fixes and font-synchronised fixtures passed all 36 terminal browser cases and 4 terminal unit cases, including zoom, repeated reopen, background mouse modes, split escape sequences, and clipboard safety. These terminal changes are included alongside the agent rebuild without reverting commit `1bc77ce`. The existing Vite development dependency has a reported advisory; `npm audit --omit=dev` reports no production dependency vulnerabilities. That advisory remains a separate known issue.

### Deliberate boundaries

- Still's conversations are saved locally, with provider-owned session IDs used for resume. They are not a cross-device synchronized T3 backend.
- Deleting a conversation closes the attached driver and removes Still's transcript/metadata. It does not remove remote files, tmux sessions, or the provider's own history.
- Pi and Claude expose runtime command inventories; Codex exposes the explicitly implemented native review/compact actions. TUI-only controls are not assumed portable.
- Tool presentation handles supplied structured fields and diffs; it does not infer edits by scraping terminal text. Advanced attachment, git/worktree, subagent-control, and remote-supervision parity are separate work.
- Screenshots and the browser fixture contain synthetic test conversations/models, not demonstrations of authenticated execution.

### Finish review and fixes

A separate read-only finish review accepted the documented visual direction and found lifecycle/state problems. The follow-up fixes retain complete received conversation history in Still storage instead of silently dropping it at 500 events; expose save failures; keep titles independent of the first retained event; preserve resumed history without serializing it twice; prevent replacement of uncertain live submissions; require a confirmed bounded shutdown before deletion; hold OpenCode command completion while forms/questions remain; preserve multi-select question values; disclose structured approval input; and prioritize attention over working indicators. Conversation ownership is transferred immediately when the native execution is created, so later typing and navigation are not erased by initialization finishing.

History is still device-local and subject to storage capacity; storage exhaustion is an explicit warning, not a successful save. Native snapshot replay is bounded, but already received renderer history is retained across refreshes. No cross-device sync or detached-agent survival is implied.

Reference implementation points: `apps/web/src/hooks/useSidebarProjectGroups.ts`, `sidebarProjectGrouping.ts`, `hooks/useThreadActions.ts`, `components/threadActionMenu.logic.ts`, `components/chat/ComposerControlsBar.tsx`, `MessagesTimeline.logic.ts`, `packages/provider-opencode/src/server/driver.ts`, and `packages/provider-opencode/src/server/v2/adapter.ts`. T3's MIT licence allows adaptation with attribution; copying its whole backend/dependency graph is unnecessary.

---

## Revision 1 — historical implementation record

Evidence reviewed 26 October 2026. T3 Code source snapshot: `cc0b86ddf12a34bd65dce88d6f2ae1f069ef841e`.

## What T3 gets right

- Its [composer](https://github.com/t3tools/t3code/blob/cc0b86ddf12a34bd65dce88d6f2ae1f069ef841e/apps/web/src/components/chat/ChatComposer.tsx) combines provider/model selection, supported runtime modes, reasoning controls, activity, and actionable setup banners. Controls depend on the connected provider, not a universal feature checklist.
- Its [timeline](https://github.com/t3tools/t3code/tree/cc0b86ddf12a34bd65dce88d6f2ae1f069ef841e/apps/web/src/components/chat) groups work rather than printing protocol frames. Conversation, expandable tools, reasoning, and approvals have different presentations.
- Its [provider drivers](https://github.com/t3tools/t3code/tree/cc0b86ddf12a34bd65dce88d6f2ae1f069ef841e/apps/server/src/provider) manage real setup/auth/state differences. T3 is not simply a dropdown over identical ACP commands.
- Its [README](https://github.com/t3tools/t3code/blob/cc0b86ddf12a34bd65dce88d6f2ae1f069ef841e/README.md) explicitly requires installation and authentication. A provider appearing in a catalog is not proof of readiness.

## Still audit

The original panel displayed one bubble per stream chunk, had no provider detection/setup workflow, only rendered model-category config, hid all tool activity behind a global toggle, and offered no project-directory override. Plain SSH exec can miss user-installed executables because it does not load a login environment. Config submission returned before the remote acknowledgement, and permission/cancellation failures could leave stale state.

Two native compatibility defects were also found: initialization rejected agents that advertised terminal or multiple authentication methods even when the remote account was already signed in; any stderr diagnostic immediately killed the ACP connection. The implementation now tries `session/new` with the remote account's existing credentials, retains bounded stderr for failure diagnosis, and times out initialization explicitly. It does not initiate an interactive authentication method without user action.

## Implementation direction

Keep Still's dark, restrained, offline-capable desktop visual system. Replace the modal with a full-window working surface: thread navigation; readable, coalesced conversation; expandable tools and reasoning; plan; inline permission decisions; a fixed composer with all advertised configuration options and commands; explicit remote provider setup and project-directory selection. Preserve drafts per thread and keep scrolling under the reader's control.

Check executable availability through the existing authenticated, host-key-verified SSH connection. Launch in a login environment with common per-user executable directories. Allow a literal absolute executable path, not arbitrary shell command injection. Installation/authentication remain explicit terminal operations; Still does not install packages or store provider credentials. A detection check establishes executable availability, **not** successful authentication or real-agent compatibility.

Prefer ACP `configOptions`; support older advertised session modes/models only where the corresponding modern category is absent. Apply config values after an acknowledged result and validate selections on the native side. Never invent model lists, approval policies, slash commands, token counts, diffs, or persistence guarantees.

## Adapter references

- [OpenCode ACP](https://opencode.ai/docs/acp/): `opencode acp`.
- [Pi adapter](https://github.com/svkozak/pi-acp): install `pi-acp` as well as Pi; it spawns `pi --mode rpc`. Community/MVP adapter; tools may run without approval.
- [Current Codex adapter](https://github.com/agentclientprotocol/codex-acp): `@agentclientprotocol/codex-acp`, backed by Codex App Server. This supersedes the old Zed adapter.
- [Claude adapter](https://github.com/zed-industries/claude-agent-acp): `@agentclientprotocol/claude-agent-acp`, using the Agent SDK. Authenticate on the execution host.
- [Gemini CLI source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts): current `--acp`, deprecated `--experimental-acp` alias.
- [ACP configuration contract](https://agentclientprotocol.com/protocol/session-config-options): arbitrary categorized selectors; `configOptions` preferred to legacy modes.

## Verification boundary

Local native protocol tests and browser interaction fixtures cover behavior, not live SSH/provider authentication. Browser fixtures must explicitly register a test bridge; ordinary browser mode still refuses remote execution. Closing the panel leaves the native foreground runner attached. Closing Still or losing SSH is **not** a guarantee that the agent continues; remote supervision remains a separate reliability project. This work does not claim T3's native-driver, git/worktree, attachment, or background-supervision parity.

Checks: `npm run test:agents` (8 browser cases), `cargo test --lib` (36 tests), existing regression/preset checks, terminal browser tests, typecheck and production build. The build retains its existing bundle-size/dynamic-import warnings. Browser fixture model names and conversations are deliberately synthetic test data.
