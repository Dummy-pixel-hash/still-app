# Specification 02 — “Supported by this agent”

Roadmap: **AG-11b**. Contract: [01-capabilities.md](01-capabilities.md).
Mode: **Operate** — explain availability while the user works in a conversation.

## Job and outcome

A user sees an unavailable feature or wonders whether Todos are actually connected.
They can inspect the selected agent's real integration and understand the next
action in one disclosure. The evidence refers to their conversation's host, folder,
runtime, and settings, not the last provider selected elsewhere.

## Visual authority and placement

Use `DESIGN.md`, current `AgentControls.tsx`, `AgentModelPicker.tsx`, the configuration
dialogs in `AgentWorkspace.tsx`, and shared material tokens. This is an addition to
the incumbent interface.

The pack README records concurrent UI changes through `e25bb3d`, including removal
of the custom backdrop renderer. Inspect current CSS/components before editing;
older design-history wording is not an instruction to recreate removed machinery.

- Add a quiet text button **“Agent details”** on the existing context/metadata line
  for the current or prepared agent. Accessible name:
  **“Agent details: Supported by this agent”**, retaining the visible label in it.
- It opens one small **nonmodal popover** with `role="dialog"`, headed
  **“Supported by this agent”**. Use `useAgentPopover` with managed focus and the
  established outside-click/Escape pattern. Keep this interaction at compact sizes
  too; viewport constraints make its body scroll rather than introducing another
  mobile-only modal architecture.
- Reuse one new `AgentCapabilities` component for report content. Its props are
  `report?: AgentCapabilityReport`, `providerLabel: string`,
  `state: "connecting" | "live" | "offline" | "unavailable"`,
  `refresh?: () => Promise<void>`, and `close: () => void`. The parent owns trigger
  and open state; the component owns local refresh pending/error display. It does
  not query providers itself.
- In Agent settings, the existing provider `<details>` rows show installation
  version/transport and last-checked state from discovery. They do not pretend to
  contain a project/session capability report.
- Use a definition list or simple rows, restrained status text, existing type and
  spacing. The information panel is content, not a new settings dashboard.

## Content hierarchy

1. Provider name and version, with “Version not reported” when absent.
2. Human-readable transport label; optional executable path as wrapping monospace.
3. Observation label: current connection or saved/last-observed report.
4. Four feature rows in the order below, each with status and one short explanation.
5. A scoped **“Refresh report”** action when an existing live execution is available.

| Contract key | Visible label |
| --- | --- |
| `sharedTodos` | Agent-managed Todos |
| `providerPlans` | Provider plan snapshots |
| `providerTaskProjection` | Native task synchronization |
| `clientTodoWrite` | Manual Todo editing |

Use exact states **Supported**, **Unavailable**, and **Not verified** for the three
contract statuses. The persisted key stays `unsupported`; “Unavailable” is display
copy. Status must be understandable without color.

Evidence detail is plain language, not internal protocol names:

- Advertised shared tool: “Tool connected. A tool call has not been observed yet.”
- Observed shared tool: “A Todo tool call was observed in this configuration.”
- Manual editing: “The agent manages task names and Done/Not done status.”
- Task projection unavailable: “Native provider tasks are not synchronized here.”
- Provider plan unverified: “Waiting for this session to report a structured plan.”

Use the bounded reason from the report for provider-specific explanations. Do not
display arbitrary raw initialize responses, stderr dumps, tokens, or runtime config.

## State table

| Situation | What the user sees / can do |
| --- | --- |
| No selected project or active/prepared conversation | No fabricated report. Settings can still explain installation detection |
| Selected provider is connecting | “Checking this connection…”; report rows remain unverified |
| Valid current report | Four rows plus source-specific explanation |
| Connected route, no invocation | Supported with connection evidence; never “Live verified” |
| Configuration changed, awaiting new evidence | “Settings changed. Tool-call evidence has not been observed for this configuration.” |
| Saved/offline report | “Last observed on this connection”; old values remain readable and visibly stale |
| Older worker with no report | “This execution does not report capability details.” |
| Unknown version | “Version not reported”; no invented zero/latest/native version |
| Snapshot refresh fails | Keep the previous report; show bounded inline failure and retry |
| Host/provider/execution changes while open | Close disclosure and discard pending old-scope UI results |
| Gemini session startup blocked | Existing startup error remains authoritative; no supported inference/task claim |

Refreshing calls existing snapshot/discovery paths. It does not create a new
conversation, submit a prompt, switch models, change credentials, or install a CLI.
Refreshing a snapshot need not update the report's `observedAt`: only newly observed
facts do that. A stale disconnected report describes reconnection through the
existing connection flow rather than adding another Connect-agent button.

## Existing controls

The explanatory report does not replace live authorities:

- Model/mode values come from `configOptions`; command availability comes from the
  current command inventory.
- Revert/Retry remain gated by native history capabilities, checkpoints, and the
  existing idle/uncertainty guards.
- The Todo panel remains read-only. Its collapsed pill and expand/collapse behavior
  use the accepted implementation.
- Do not add disabled toolbar buttons for every future roadmap feature. Explain an
  unavailable operation at its existing control or in this details disclosure.

## Interaction and accessibility

- Trigger is a real button with `aria-expanded`, `aria-controls`, and a named dialog.
- Enter/Space opens it; focus moves into the disclosure. Escape closes only this
  topmost surface and returns focus to its still-mounted trigger.
- Outside click follows the existing popover behavior. Closing must not send a
  prompt or collapse a user's draft.
- At compact dimensions, constrain it to the viewport with a scrollable body and
  visible close action. This popover has no `aria-modal`, background inert state, or
  focus trap; ordinary Tab navigation remains available. Escape restores the trigger.
- Test **1280×800**, **900×600**, **390×844**, and **1280×520**. Long executable paths,
  reasons, and versions wrap without hiding status or actions.
- Use existing motion timing and reduced-motion support; no polling or animation
  loop is needed for static metadata.
- Routine report changes use a small `role="status"` region only while open. Avoid
  stealing focus or announcing every background metadata event.

## Files and callers

Expected UI additions: `src/components/AgentCapabilities.tsx` (new), a small
capability selector in `src/agents/capabilities.ts` (new, if not already introduced
by the renderer task), `AgentWorkspace.tsx`, and narrowly scoped existing CSS.

Reuse `src/agents/useAgentPopover.ts`. Inspect the modal/popover dismissal chain in
`AgentWorkspace.tsx` before adding local state. Update the existing fixture, not a
separate production UI path. `agentMocks.ts` remains an unavailable remote bridge in
browser development; simulated reports belong only to test fixtures.

## Acceptance IDs

| ID | Observable result |
| --- | --- |
| UI-AC1 | Details always refer to the current/prepared execution and selected host/folder |
| UI-AC2 | Current, stale, connecting, legacy, unknown version, and failed-refresh states are distinguishable |
| UI-AC3 | Connected registration is not labelled as a verified model operation |
| UI-AC4 | Keyboard open/close, focus return, compact overflow, and reduced motion work |
| UI-AC5 | Drafts, Todo pill geometry, existing provider controls, and Changes navigation keep working |
| UI-AC6 | Capability display alone cannot enable an unsupported native operation |

Validate with the fixture acceptance tests and one packaged WebView2 interaction
pass. Existing glass evidence covers material rendering, not this new interaction.
