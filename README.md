# Still — production application (bootstrap 0.1.0)

Clean rebuild: React + TypeScript + Vite + Tailwind → xterm.js → Tauri 2 → Rust.

## Scope of this milestone

Clean production foundation only. Implemented:

- Minimal Still-styled shell (custom frameless title bar, no stock browser chrome)
- Basic xterm.js terminal surface (local echo; keyboard input, fit/resize, focus)
- Typed native bridge abstraction (`src/bridge/nativeBridge.ts`):
  production `tauriBridge` under Tauri, development-only `mockBridge` in the browser
- Tauri 2 desktop app: frameless window, `still_ping` IPC probe, app state structure
- Real window commands (minimize / maximize-restore / close / drag) via Tauri API

Explicitly NOT implemented: real SSH, tmux, credentials/secret storage,
session persistence, settings, session forms, Android packaging, cloud backend.

## Security boundary

React is not trusted with long-lived secrets. Rust will own credentials and
native secure storage; the renderer receives opaque handles. The mock bridge
never opens sockets and never stores secrets. Nothing in this milestone uses
localStorage / sessionStorage / IndexedDB for passwords or private keys.

## Develop

```sh
pnpm install
pnpm dev        # browser: mock bridge (local simulation, no native runtime)
pnpm tauri dev  # desktop: Tauri + Rust backend
pnpm typecheck
pnpm build
```

## Validate

```sh
pnpm typecheck
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

## M5 — SSH host-key verification (implemented)

Rust is the single authority for server identity. There is exactly ONE
verification path, executed inside the russh handshake **before any credential
byte is written**:

| Case | Behaviour |
| --- | --- |
| Never-trusted host | Handshake refused. `HostKeyPrompt { changed: false }` + typed `host_key_unknown`. No auth attempted. |
| Trusted host (stored key matches) | Verified, proceeds to auth + tmux. |
| Stored key differs | Handshake refused. `HostKeyPrompt { changed: true }` + typed `host_key_changed`. The stored key is NEVER overwritten. |
| Reject (user) | No connection, no trust persisted. |
| Corrupt trust data | Fails closed (treated as untrusted), never as verified. |

Trust store (native, Rust-owned): `$XDG_CONFIG_HOME/still/known_hosts.json`
(override for tests: `STILL_KNOWN_HOSTS`), mapping `"<lowercased-host>:<port>"`
to the OpenSSH public-key string. It holds public host keys only — never a
password or private key. Writes are atomic (tmp + rename). The renderer never
reads or writes it.

Trust is granted only by the user pressing **Trust this server**, which calls
`still_trust_host`; that command re-probes the LIVE server key and persists it
only if it still matches the exact key the user reviewed (TOCTOU-safe).

### IPC (additive)

- events: `still://session-event/<id>` gains `{ type: "hostKeyPrompt", prompt }`
- `still_probe_host({ host, port })` -> live key identity + trust state, no auth
- `still_trust_host({ host, port, expectedOpenssh })` -> persists explicit trust
- `still_forget_host({ host, port })` -> drops trust (surfaces as unknown host)

### Validate host keys

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml --test hostkey_m5
cargo test --offline --manifest-path src-tauri/Cargo.toml --test headless_ssh_hostkey
node tests-m5/regressions.mjs
```

`hostkey_m5` needs a local sshd on 127.0.0.1:22222 with `PerSourcePenalties no`
(the refusals it deliberately triggers are otherwise throttled by sshd).

## Terminal input, scrolling, and clipboard

- **Copy:** `Ctrl+Shift+C` copies the current xterm selection through the native
  OS clipboard. In a mouse-enabled TUI, **Shift-drag** selects local terminal text.
  tmux/TUI selections sent via OSC 52 are also supported: Still shows “TUI
  selection ready”; `Ctrl+Shift+C` transfers that selection to the OS clipboard.
  Local selection wins. Remote requests alone never modify or read the clipboard.
  Staged transfers are bounded to 1 MiB, expire after 30 seconds, and are not
  restored from transcript replay or across connections.
- **Paste:** `Ctrl+Shift+V` reads the OS clipboard once and calls xterm's paste API.
  Bracketed paste is honored when the remote application enables it. Applications
  that do not enable bracketed paste may still interpret embedded newlines as Enter.
- **Scroll:** normal scrollback stays local. Touchpad deltas in mouse-reporting
  or alternate-screen applications are accumulated into line steps, retaining
  magnitude instead of discarding it; each gesture's reports share one IPC write.
- Output bypasses per-chunk disk diagnostics and an extra animation-frame queue.
  Transcript append uses a bounded byte ring, not repeated whole-array shifts.
- Connect applies mouse/history settings to the Still session and enables supported
  tmux server keyboard/clipboard options. `set-clipboard on` permits application
  OSC 52 transfers; Still still requires the explicit local copy shortcut. The
  history limit affects future panes, not history already discarded. No server
  restart or edits to `~/.tmux.conf` are needed; **do not kill existing sessions**.

### Verify terminal behavior

```sh
npm run typecheck
npm run build
# Install a test browser once, or set STILL_TEST_BROWSER to an installed Chrome.
npx playwright install chromium
npm run test:terminal
npm run bench:terminal
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --bins
cargo test --locked --manifest-path src-tauri/Cargo.toml --test tmux_options
# Unix + Python + tmux: real PTY wheel/copy-mode/OSC52 check on a private socket.
python3 tests-terminal/tmux-pty.py
```

Browser interaction tests use real xterm, including its alternate-screen and
mouse protocols; only the SSH/OS clipboard bridge is mocked. The packaged
Windows clipboard and physical touchpad still need a Windows runtime check.
The legacy M3 source check for `authOpen` currently fails independently of these
changes (M5 and M6 pass); it is not masked or removed by the new tests.
