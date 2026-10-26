# Agent workspace: T3 Code review and implementation

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
