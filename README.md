# Still

> A persistent remote terminal. SSH in, work in tmux that survives
> disconnects, reattach anytime — including the sessions where your
> coding agent keeps working after you close the laptop.

[![Windows build](https://github.com/Dummy-pixel-hash/still-app/actions/workflows/windows-arm64.yml/badge.svg)](https://github.com/Dummy-pixel-hash/still-app/actions/workflows/windows-arm64.yml)
[![Latest release](https://img.shields.io/github/v/release/Dummy-pixel-hash/still-app)](https://github.com/Dummy-pixel-hash/still-app/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](LICENSE)

## Demo

🎥 Video walkthrough coming soon.
<img width="1593" height="951" alt="image" src="https://github.com/user-attachments/assets/ac219c16-7c96-4260-86a6-601eba5b3915" />



<img width="1513" height="906" alt="Screenshot 2026-10-09 002757" src="https://github.com/user-attachments/assets/9481cb7b-d993-4e88-b6db-65cdca4ca259" />


<!--
Demo video: drop the file in docs/ (gitignored scratch space) and point
the tag below at the release asset URL, e.g.
<video src="https://github.com/Dummy-pixel-hash/still-app/releases/download/v0.1.0/demo.mp4" controls width="100%"></video>
-->

## Why

Close the laptop, kill the wifi, come back tomorrow — the remote session
is exactly where you left it. One card per session, one tmux session per
card, always reattachable.

Built for long sessions: late-night servers, and multi-hour agent coding
runs you don't want to babysit.

## Features

**Never lose a session** — tmux attach-or-create under the hood. Reopen a
card and it repaints live output, with a marker when things changed while
you were away.

**Connect fast** — named presets with fuzzy search. Pick a preset, type a
name, done. Auth happens once at connect time, never inside a form.

**Stay organized** — projects group cards on a spatial workspace. Drag
cards between projects; create and remove projects from the main screen.

**A terminal that respects TUIs** — correct sizing from the first frame,
no stale repaints, app shortcuts (close, zoom) never leak keystrokes into
the shell, touchpad scrolling that keeps its magnitude, `Ctrl+Shift+C` /
`Ctrl+Shift+V` clipboard, and image paste straight to `~/still-uploads`.

**Safe by default** — passwords and keys live in the OS keyring, never in
app storage. Unknown hosts need an explicit Trust; changed host keys are
refused, never silently overwritten.

## Download

Windows ARM64 → [latest Release](https://github.com/Dummy-pixel-hash/still-app/releases/latest)

## Quick start

1. Open Still → **New session** (or pick a preset, type a name, done).
2. Hit **Create & connect**.
3. Sign in when asked.
4. Close the window whenever — reopen the card to reattach.

## Security, briefly

- Secrets live in the OS keyring. The app's own storage holds connection
  metadata only — never a password or private key.
- Every new host asks for an explicit **Trust this server** before any
  credential is sent. A changed key fails closed.

## Under the hood

<details>
<summary>Stack</summary>

React 19 + TypeScript + xterm.js + Tailwind CSS, Tauri 2 + Rust (`russh`
for SSH, tmux for persistence), Vite + pnpm. Renderer and native engine
talk through a typed bridge (`src/bridge/nativeBridge.ts`); the browser
dev build swaps in a local simulation that never opens a socket.

</details>

## Develop

```sh
pnpm install
pnpm dev         # browser: local UI simulation, no native runtime
pnpm tauri dev   # desktop: Tauri + Rust backend
pnpm typecheck
node tests-m3/regressions.mjs && node tests-m5/regressions.mjs && node tests-m6/regressions.mjs
```

## Roadmap

- macOS and Linux builds
- SFTP-backed uploads for pasted images
- More platforms, more polish — issues and PRs welcome

## License

MIT — see [LICENSE](LICENSE).
