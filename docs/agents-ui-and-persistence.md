# Agent controls and persistent execution

## Composer

The model control opens a searchable, grouped menu. Reasoning choices live in the
same menu and are taken from the current agent's configuration; selecting a model
keeps the menu open. Model and reasoning updates are serialized, use the provider's
acknowledged values, and never submit the message draft. The adjacent **Agent**
control selects the provider's mode (for example, Build or Plan).

Conversation settings has been removed. Session refresh is available through
`/refresh-session`; additional provider controls appear as individually named
configuration entries in command search. Sidebar Agent settings still manages
installation and executable paths.

Questions and permissions appear in the conversation. A compact composer strip
links to the pending request. **Expand request** moves the same request into a
focused dialog with a scrolling body and persistent actions. Radio/checkbox rows
replace single/multi-select boxes. Answers are submitted explicitly, unfinished
answers stay in memory, and response errors preserve the draft. An ambiguous
delivery requires checking status before retrying. History records request
identity and outcomes, not unfinished form answers or raw permission arguments.

## Sleep, disconnects, and local power-off

New agent executions are owned by a detached Node.js worker **on the SSH server**,
not by the laptop's SSH channel. Node.js 20 or newer is required for all providers,
including Gemini's ACP transport.

- Each execution has a private directory under
  `~/.local/state/still/agents/<execution-id>/` and a user-owned Unix socket in
  `/tmp`. No listening TCP port or new external service is exposed.
- The worker retains the provider process, appends a replay journal, and keeps
  unanswered agent requests alive when the client disappears.
- Reattachment uses the same execution identity and a saved event cursor. Missed
  output and pending requests are recovered without sending the prompt again.
- Prompt receipts prevent duplicate submission of an existing message identity.
- Questions/approval responses receive a worker acknowledgement. This confirms
  forwarding, not successful completion of the requested operation.
- Wake/online/focus recovery reconnects an already-used server with saved
  credentials. It never bypasses host-key verification or opens unsolicited
  password dialogs. Without saved credentials, use **Connect server**.
- After a full app restart, selecting the saved persistent conversation and
  connecting its server reattaches to the worker. Global library access remains
  offline-first and does not choose a server automatically.
- Explicit cleanup of an unused preparation or closed execution stops that worker.
  Simply closing the Agents panel is not a stop operation.

Existing foreground executions from older builds are not retroactively moved into
a detached worker. Resume their saved provider session, or start a new conversation,
to use the new execution model.

### Boundaries

The remote server must remain powered on. Server reboots, process crashes, and
administrators terminating user processes are not hidden by the reconnect logic.
An unavailable worker is reported instead of silently starting a replacement.
Servers using `KillUserProcesses=yes` or similar logout policies may require an
administrator-approved lingering/service configuration. Still does not alter those
policies or prevent the client machine from sleeping.

Worker logs, state, and protocol journals are private to the server account. They
can include agent conversation content, so treat the execution directory as
sensitive application data. No credentials are placed in the execution metadata.

## Verification

`npm run test:agents:persistence` covers request normalization and a real detached
subprocess: the SSH-equivalent transport is killed, the worker continues, and a
new client receives the result with the same worker/provider PIDs. It also checks
pending-question recovery and duplicate-prompt rejection.

`npm run test:agents:ui` covers controls, keyboard/focus behavior, requests,
acknowledged outcomes, compact layouts, and reattachment without another prompt.
Rust unit tests exercise native history redaction and replay.

These tests simulate transport loss; physical lid-close and power-cycle testing
of the packaged desktop builds remains a manual cross-platform check.

## Browser preview

Run `npm run dev -- --host 0.0.0.0 --port 1433`, then open:

- `/tests-agents/fixture.html?demo&scenario=models`
- `/tests-agents/fixture.html?demo&scenario=question`
- `/tests-agents/fixture.html?demo&scenario=approval`

These are explicitly synthetic examples; the browser preview does not execute a
real local or remote coding agent.
