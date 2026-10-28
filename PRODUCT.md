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

The global Agents entry opens a device-owned conversation library with no implicit server or project. A project is an explicitly chosen server/account and canonical remote folder. New servers can be added for agents without creating terminal cards. Saved conversations can be read offline; connecting to resume is a deliberate action. Still stores its conversation history, drafts, project organization, and provider-session references under the native application-data directory. The remote provider remains the authority for executing and resuming its own session.

For a new conversation, sending the first message starts the selected coding agent and submits that message once startup is ready. Choosing a provider, browsing its catalog, or opening conversation settings does not start an agent session. The composer has no manual Connect-agent action.

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
