# Agent workspace: T3 Code review and implementation

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
