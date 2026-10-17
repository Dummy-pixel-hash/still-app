# Smoked-glass orb companion

The selected **B · Smoked glass** study is now a reusable renderer and an opt-in companion in Still. This is the window/interaction foundation with **observed connection activity**, not a restored agent classifier.

## Use

Open **Settings → Orb companion → Float above other apps** in the desktop app. It is off by default. Choose a 48, 64, or 96px visible orb; 64px is the default.

- **Click / Enter / Space:** return to the most urgent observed session, or show Still when there are none.
- **Drag:** move the companion without activating a session.
- **Right-click / context-menu key / Shift+F10:** session list, Open Still, pause/resume, reset position, and hide.
- **Arrow keys while focused:** move 8 logical pixels; Shift+arrow moves 20.
- **Reset position:** return to the main window's display corner, inside the display's work area.
- **Pause:** stop animation while keeping the material visible. System reduced motion also stops animation.

The companion remains visible while Still is minimized. Showing it and updating its status do not request focus; focus is acquired only for a user interaction. Closing Still closes the companion and exits normally. Hiding the orb does not disconnect sessions. Position is remembered on hide/close in the native app configuration directory (`orb-position.v1.json`); unavailable displays and invalid positions are clamped to an available work area.

Session activation resolves stable local IDs against the current workspace. It handles filtered cards and temporary terminals. Existing dialogs keep their focus so drafts and authentication promises are not discarded. An orb-opened view does **not** automatically reconnect, even if the connection closes during its opening transition.

## What the signal means today

| Observation | Display | Material |
| --- | --- | --- |
| No active connections | No active connections | Neutral; slow ambient drift |
| Connection being established | Connecting | Quiet neutral; slow ambient drift |
| Terminal bytes received within the last 3 seconds | Output active | Blue/violet moving ribbon |
| Connected, without recent output | Connected · agent status unknown | Quiet neutral; slow ambient drift |
| Actual credential prompt | Sign-in required | Amber attention |
| Actual untrusted host-key prompt | Review host key | Amber attention |
| Actual changed key or connection failure | Host key changed / Connection error | Red/pink |
| No fresh publisher update for 15 seconds | Status unavailable | Neutral, unknown; slow ambient drift |

**Output is not proof that an agent is working. Silence is not proof that it is waiting or done.** Agent-specific approval/completion adapters are intentionally deferred. The renderer supports completion and other visual states so they can be supplied later by an explicit, trustworthy signal source. No live connection is currently classified as completed.

The standalone `tests-orb/fixture.html` page deliberately demonstrates synthetic visual states; it is not connected to any session and is not an application entry in the production build.

## Browser preview

```sh
npm run dev -- --host 0.0.0.0
```

Open port **1420**, then **Settings → Orb companion → Show in-app preview**. The labelled preview stays inside that browser window; it is not an OS overlay. Its actions and metadata transport use the existing development-only simulation. Neither this preview nor the renderer opens sockets, runs shell commands, or accesses a microphone.

The approved original studies remain separate at `../orb-mockups/` (port 4178 when their Python server is running).

## Boundaries

- `src/orb/glassRenderer.ts` and `glassShader.ts`: original approved shader, a Canvas2D fallback, bounded DPR/frame rate, reduced motion, visibility and resource cleanup.
- `src/orb/state.ts`: pure presentation of observed facts, urgency, activity expiry, settings validation, and browser geometry.
- `src/orb/publisher.ts` / `useOrbPublisher.ts`: main-window-only observer. Data callbacks record a timestamp, not terminal content. Bursts are coalesced; a small heartbeat continues independently of animation frames.
- `src/screens/OrbScreen.tsx`: isolated native route (`?orb=1`). It never mounts Workspace, xterm, a connection owner, or the settings store.
- `src-tauri/src/orb.rs`: caller-checked orb commands, bounded metadata retention/events, native window/menu/focus/placement, and application lifecycle.
- `src-tauri/capabilities/orb.json`: a separate event-subscription capability, not the main window's clipboard permissions.

Snapshots contain only stable local IDs, bounded display names, connection/attention states, and timestamps. They do not contain session connection arguments, credentials, terminal snippets, or raw bytes. Main is the sole publisher; the companion subscribes before fetching the retained snapshot and ignores older revisions. Up to 64 rows are retained, ordered by attention; menus show the first 12 with a link back to Still for the rest.

No previous scrape/hooks/Smart stack was restored. SSH workers, host-key verification, tmux behavior, and terminal batching remain unchanged. The only terminal-view addition prevents automatic connection on companion activation.

## Verification

```sh
npm run build
npm run test:orb
npm run test:regressions
npm run test:presets
npm run test:terminal -- --output=test-results/terminal
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --test shutdown_lifecycle
```

The orb suite includes behavioral tests for truthful labels/expiry, publication coalescing, reconnect/removal ownership, async listener cleanup, subscription ordering, enable/disable races, missing-runtime failures, native-entry isolation, WebGL alpha and context-loss fallback, reduced motion, menu/dragging, activation without reconnecting, and compact/mobile settings. Browser captures are written to `test-results/orb-review/`.

Native Linux/X11 smoke testing passed ten checks in an isolated Xvfb/KWin desktop with no SSH connections: startup focus, native always-on-top/taskbar flags, all three actual window sizes, dragging without activating main, context-menu/keyboard interaction, continued availability while minimized, restoring/focusing main, and closing both windows normally. The metadata heartbeat remained fresh after 16 seconds minimized. These are useful native IPC/window checks, **not Windows compositor validation**.

Visual review was performed locally in Chrome and the native Linux test desktop. The mechanical design scan reported advisory palette/radius documentation gaps (the scoped orb material and existing workspace literals), not behavioral failures. The approved material and incumbent workspace were preserved rather than recoloured to silence those advisories.

### Before a Windows release

Manually check on the real Windows builds:

- Transparency over both a light and a dark application; no rectangular border or shadow.
- All three sizes, 100/125/150/200% scaling, negative-coordinate displays, and crossing displays.
- First-show placement clear of the taskbar; recovery after unplugging a display.
- No focus theft on launch/update; click restores a minimized Still and the right session.
- Drag does not click; context menu, keyboard nudge, reset, pause, hide, and re-enable.
- Main close exits with the companion open; no extra taskbar entry or disconnected worker caused by hiding it.

Pixel transparency and native composition depend on the OS/WebView. A headless Chrome screenshot or successful Rust compilation alone cannot establish those behaviors on Windows.
