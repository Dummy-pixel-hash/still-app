# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

React/TypeScript UI inside Tauri 2. The shipped desktop builds target Windows x64 and ARM64; the browser development adapter is an explicitly local simulation.

## Product Purpose

Still is a persistent remote terminal: SSH into a server, work in a per-card tmux session, disconnect, and reattach later without replacing the remote session.

## Operating Context

The workspace groups session cards into projects. Opening a card opens the terminal; leaving the terminal view does not disconnect its worker. Credentials are requested at connection time and optionally retained in the OS keyring. Host-key trust requires an explicit decision.

The user is adding an opt-in floating orb to glance at sessions while working elsewhere. The first integration exposes observed connection activity and connection-related attention. Agent-specific approval and completion detection is not yet established.

The agent workspace is a project-and-conversation surface for existing coding agents on remote servers. The user explicitly selected `pingdotgg/t3code` as the reference for organisation, visual hierarchy, and interaction. Opening Agents must open that surface directly; it must not create or navigate into a terminal as a connection prerequisite. Terminal folders and agent project folders have independent ownership.

The global Agents entry opens a device-owned conversation library with no implicit server or project. A project is an explicitly chosen server/account and canonical remote folder. New servers can be added for agents without creating terminal cards. Saved conversations can be read offline; selecting a saved conversation deliberately selects its saved server and connects automatically. Credentials and host-key verification remain explicit. After connection, Still automatically reattaches to a persistent execution or resumes a saved provider session without a separate Resume/Reattach button. Still stores its conversation history, drafts, project organization, and provider-session references under the native application-data directory. The remote provider remains the authority for executing and resuming its own session.

Each supported remote agent execution also has a shared conversation todo list. The `still_todos` tool is the sole writer; Still displays a collapsed three-item summary above the composer, expanding to a read-only timeline with task names, Done/Not done state, and agent-reported active-task detail and durations. Snapshots are retained in Still history for offline reading. Todo completion is checklist progress only: it does not imply a finished turn, successful tests, or a completed change. Older live remote workers that do not implement worker protocol v3 remain read-only until a new supported execution is started. Provider-native plans remain distinct from Still's shared todo list.

For a new conversation, selecting a coding agent for a deliberately chosen project automatically connects it and loads its models before sending. The user can choose the first message's model and supported settings while the draft remains unsent. Switching providers retires the unused connection and preserves the project draft. The composer has no manual Connect-agent action.

Supported providers expose message-level Revert and Retry after a real provider checkpoint is available. Revert returns the active conversation to before the chosen message; Retry performs that revert and submits the same message once with the selected model. These are conversation-history actions and keep project files as they are. Native persistence records provider acknowledgements and keeps uncertain operations blocked until reconciled. Unsupported integrations do not display functioning history actions.

## Capabilities and Constraints

- Preserve session identity, tmux persistence, terminal rendering, authentication, and host-key checks.
- No passwords or private keys in renderer storage; no terminal output or credentials in companion snapshots.
- Browser simulation must never replace a missing native runtime in a production bundle.
- The companion is not a voice assistant: no microphone or model endpoint is needed for its appearance.

## Brand Commitments

The name is Still. The existing workspace identity is retained. The user selected **B · Smoked glass** from the standalone orb studies: a dark shell with a restrained folded ribbon of light, not a full-rainbow voice visualizer.

For Agents, the user explicitly wants the craft and interaction of **T3 Code or Codex**. Their actual desktop interfaces are the visual authority: project/conversation navigation, a focused start screen, an integrated coding conversation, and inspectable file changes. The October 28 request supersedes the muted sage visual treatment, while local history, deliberate project selection, and collapsible navigation remain product requirements.

## Evidence on Hand

`README.md`, `src/styles/`, and existing components establish current product behavior and identity. The approved orb reference is `../orb-mockups/smoked-glass.html`, with original rendering code in `../orb-mockups/orbs.js` and browser captures in `../orb-mockups/screenshots/`.
