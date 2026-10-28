# Still

> **Your connection can drop. Your work doesn't have to.**
>
> Still is a persistent remote terminal for the work that outlasts your Wi-Fi,
> your laptop battery, or your decision to call it a night. SSH into a server,
> work in tmux, and come back to the same session later—including the one where
> your coding agent is still busy.

[![Windows ARM64 build](https://github.com/Dummy-pixel-hash/still-app/actions/workflows/windows-arm64.yml/badge.svg)](https://github.com/Dummy-pixel-hash/still-app/actions/workflows/windows-arm64.yml)
[![Windows x64 build](https://github.com/Dummy-pixel-hash/still-app/actions/workflows/windows-x64.yml/badge.svg)](https://github.com/Dummy-pixel-hash/still-app/actions/workflows/windows-x64.yml)
[![Latest release](https://img.shields.io/github/v/release/Dummy-pixel-hash/still-app)](https://github.com/Dummy-pixel-hash/still-app/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](LICENSE)

## Take a look

🎥 Video walkthrough coming soon. Until then, here are a couple of stills from Still:

<img width="1593" height="951" alt="Still app screenshot" src="https://github.com/user-attachments/assets/ac219c16-7c96-4260-86a6-601eba5b3915" />

<img width="1513" height="906" alt="Still app screenshot" src="https://github.com/user-attachments/assets/9481cb7b-d993-4e88-b6db-65cdca4ca259" />

<!--
Demo video: drop the file in docs/ (gitignored scratch space) and point
the tag below at the release asset URL, e.g.
<video src="https://github.com/Dummy-pixel-hash/still-app/releases/download/v0.1.0/demo.mp4" controls width="100%"></video>
-->

## Why Still?

The Wi-Fi is not a process manager. Close the laptop, lose the train
connection, go get some sleep: your remote tmux session keeps running on the
server. Open Still later and reattach to pick up where you left off.

Each session gets its own card and its own tmux session. Your long-running
server work and coding-agent runs can keep going without you hovering over them.

## What it does while you're away

**Walk away. Come back to the same work.** Still uses tmux attach-or-create,
so a session is ready when you reopen its card. Previews fit their cards and
keep the last complete frame on screen while rebuilding; a marker lets you know
when output changed while you were gone.

**Get connected, skip the form safari.** Save named connection presets, find
them with fuzzy search, and connect when you're ready. Credentials are
requested at connection time—not tucked into a setup form.

**Give every session a place to live.** Projects group session cards on a
spatial workspace. Drag cards between projects, or create and remove projects
from the main screen.

**A terminal that knows what a terminal is for.** TUIs get correct sizing from
the first frame. App shortcuts stay in the app instead of leaking into your
shell; touchpad scrolling keeps its magnitude; and `Ctrl+Shift+C` /
`Ctrl+Shift+V` handle clipboard work. Paste an image straight to
`~/still-uploads`, then choose “Insert into agent” to send its path to Claude
Code, Codex, OpenCode, or Pi.

**A little orb, not a pretend mind-reader.** The opt-in floating orb shows
connection activity and credential or host-key attention, with one-click
return to Still. Turn it on in **Settings → Orb companion**. Agent-specific
approval and completion detection isn't wired yet, so silence never means
“done.” See [orb behavior and verification](ORB.md).

**Security that doesn't take shortcuts.** Passwords and keys live in the OS
keyring, never app storage. Unknown hosts need an explicit trust decision;
changed host keys are refused, never silently overwritten.

## Download

Windows ARM64 → [latest Release](https://github.com/Dummy-pixel-hash/still-app/releases/latest)

## Quick start

1. Open Still and choose **New session** (or pick a preset to skip a few steps).
2. Choose **Create & connect**.
3. Trust the server if prompted, then sign in.
4. Close Still whenever life gets in the way. Reopen the card to reattach.

## Security, briefly

- Secrets live in the OS keyring. Still's own storage keeps connection
  metadata—not passwords or private keys.
- Every new host requires an explicit **Trust this server** decision before
  credentials are sent. A changed host key fails closed.

## Under the hood

<details>
<summary>Stack (for the curious)</summary>

React 19 + TypeScript + xterm.js + Tailwind CSS, Tauri 2 + Rust (`russh` for
SSH, tmux for persistence), Vite + pnpm. The renderer and native engine talk
through a typed bridge (`src/bridge/nativeBridge.ts`); the browser dev build
swaps in a local simulation that never opens a socket.

</details>

## Develop

```sh
pnpm install
pnpm dev                  # browser: local UI simulation, no native runtime
pnpm tauri dev            # desktop: Tauri + Rust backend
pnpm typecheck
pnpm test:regressions     # fast regression checks
pnpm test:terminal        # terminal tests, including Playwright coverage
```

## What's next?

- macOS and Linux builds
- SFTP-backed uploads for pasted images
- More platforms, more polish—and contributions are welcome

## License

MIT — see [LICENSE](LICENSE).
