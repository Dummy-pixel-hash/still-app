# README screenshots

These images are checked into the repository so README previews work without
depending on GitHub user-attachment URLs.

## Agents: current-source UI preview

Captured from the actual React interface at a 1440 × 900 CSS-pixel viewport,
with a 1.5 device scale factor and reduced motion. The preview banner is retained
to make the synthetic data explicit. No real server or agent execution is shown.

Start `npm run dev` from the repository root, then use these routes and actions:

| Image | Preview route | Action |
| --- | --- | --- |
| `agents-workspace.png` | `/tests-agents/fixture.html?demo&scenario=conversation` | Open the example conversation. |
| `agents-changes.png` | `/tests-agents/fixture.html?demo&scenario=conversation` | Choose **Changes**, then **Conversation**. |
| `agents-approval.png` | `/tests-agents/fixture.html?demo&scenario=approval` | Choose **Expand request**. |
| `agents-todos.png` | `/tests-agents/fixture.html?demo&scenario=todos` | Expand the **Todos done** progress pill. |

Use a fresh browser profile when recapturing, let fonts load, and capture the full
viewport. Example data lives in `tests-agents/demo.ts` and `tests-agents/fixture.tsx`.
These are UI examples, not evidence that a provider completed the depicted work.

## Terminal: original desktop screenshots

Preserved from the previous README, without visual modifications:

- `terminal-workspace.png`: [original workspace image](https://github.com/user-attachments/assets/ac219c16-7c96-4260-86a6-601eba5b3915).
- `terminal-session.png`: [original terminal image](https://github.com/user-attachments/assets/9481cb7b-d993-4e88-b6db-65cdca4ca259).

These show the earlier desktop terminal UI, not the current-source Agents panel.
