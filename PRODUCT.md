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

## Capabilities and Constraints

- Preserve session identity, tmux persistence, terminal rendering, authentication, and host-key checks.
- No passwords or private keys in renderer storage; no terminal output or credentials in companion snapshots.
- Browser simulation must never replace a missing native runtime in a production bundle.
- The companion is not a voice assistant: no microphone or model endpoint is needed for its appearance.

## Brand Commitments

The name is Still. The existing workspace identity is retained. The user selected **B · Smoked glass** from the standalone orb studies: a dark shell with a restrained folded ribbon of light, not a full-rainbow voice visualizer.

## Evidence on Hand

`README.md`, `src/styles/`, and existing components establish current product behavior and identity. The approved orb reference is `../orb-mockups/smoked-glass.html`, with original rendering code in `../orb-mockups/orbs.js` and browser captures in `../orb-mockups/screenshots/`.
