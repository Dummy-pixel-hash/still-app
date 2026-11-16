# History memory bounds (0.1.2)

## Finding

The reported Windows WebView2 out-of-memory crashes are consistent with an
unbounded source-code path: `still_agent_library` replayed every saved journal
and returned every complete transcript over IPC. React's initial 120-item view
was applied **after** those bodies had already been loaded. Native replay also
read whole files and cloned decoded records. Conversation checkpointing packed
the full transcript back into one large `Create` record.

This identifies a concrete memory-amplification path, not the allocation stack
from the reported Windows dumps. Those dumps and the affected 587 MB library
were not available to this test run.

## Changes

- The library returns metadata with `transcript: []` and `historyLoaded: false`.
- The native streaming projection skips transcript payloads while indexing
  identities, checkpoints and revert boundaries. It supports existing giant
  one-line checkpoint records without loading the entire line into a buffer.
- Only a selected conversation requests its recent history. Pages contain at
  most 200 events and 512 KiB of serialized event bodies (plus JSON envelope
  overhead). Large individual output previews are limited to 32 KiB and labelled
  as shortened. The full original event remains in the durable journal.
- Live native and frontend output windows are also bounded. A single endless
  assistant stream cannot bypass the limit through chunk coalescing.
- Earlier pages replace the viewed page instead of accumulating forever.
  **Back to latest activity** restores the live window. The message finder
  searches the loaded page; load an earlier page to search older messages.
  This is bounded pagination/windowing, not an infinite-scroll virtualizer.
- Truncated prompts cannot be retried as though they were complete. Partial
  edit previews do not produce fabricated whole-file diffs or line totals.
  Live permission/question schemas are not shortened as output previews.
- Prompt identities and original text used for idempotency/checkpoint actions
  are loaded separately from tool and assistant bodies in the native process.
- A bounded, file-stamp-checked metadata cache avoids re-reading a large journal
  on each draft save/account poll. Durable appends update cached metadata.
- Conversation journals remain append-only rather than repeatedly compacting
  into giant `Create` records. Workspace preferences still compact. No existing
  history is deleted or migrated just to enforce memory bounds.
- The terminal's raw-output ring was already 64 KiB. Persisted scrollback is now
  validated against the settings UI's existing 1,000–50,000-line range, including
  when passed to xterm. This does not introduce terminal-output backpressure.
- Package, Tauri and Cargo versions are aligned at **0.1.2**. An already installed
  0.1.1 executable is unchanged until a new installer is built and installed.

## Synthetic verification

The native regression creates an **84,770,091-byte**, single-line checkpoint
containing **7,323 events**. It verifies the library excludes the bodies, recent
and older pages meet their budgets and page boundaries have no gap.

One Linux debug-test measurement (`/usr/bin/time -v` on the compiled test binary):

| Measurement | Result |
| --- | ---: |
| Library row | 172 bytes |
| Recent page, including metadata | 521,152 bytes |
| Events in the byte-limited recent page | 45 |
| Peak RSS of the native test process | 58,720 KiB |

That RSS includes the test harness and fixture generation; it is **not** a
measurement of the Windows application or WebView2. The test also performs
multiple full-file scans; debug elapsed time is not a startup benchmark.

Regression entry points:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features
node --import ./tests-agents/isolated-env.mjs --test tests-agents/history-memory.test.mjs tests-agents/changes.test.mjs
node --test tests-terminal/preferences.test.mjs
npx playwright test -c tests-agents/playwright.config.ts history-memory.spec.ts
npm run build
```

Remaining release validation: build/install Windows 0.1.2, use a **backed-up
copy** of the affected library, measure native and WebView2 private bytes during
startup, opening the largest conversation, paging and sustained output, then
check for new crash dumps. Do not delete the original history to make a test pass.

Broader UI-suite caveat: `tests-agents/workspace.spec.ts:254` still waits for
`.agent-work-group > summary`, which is absent from the existing activity-layout
implementation (including the committed version). That unrelated test timed out;
the targeted memory, history paging, recovery and retry/revert cases passed.
