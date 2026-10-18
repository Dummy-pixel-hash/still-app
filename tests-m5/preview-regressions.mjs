// Preview-card regression tests — run: node tests-m5/preview-regressions.mjs
// (from still-app/).
//
// Guards the card preview geometry contract:
//   * the emulator renders at the session's REAL (capped) grid, so line
//     wraps and TUI layouts in the card match the overlay instead of a
//     fixed miniature grid;
//   * geometry changes REBUILD + replay, never resize an already-drawn
//     emulator (xterm resize reflows and smears TUIs);
//   * a card remount re-homes the live xterm DOM (xterm.open is a no-op
//     on an opened terminal, which previously left the card blank);
//   * frozen snapshots persist their grid so reloads keep the layout.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); c ? pass++ : fail++; };

const conns = readFileSync("src/session/connections.ts", "utf8");
const card = readFileSync("src/components/SessionCard.tsx", "utf8");
const surface = readFileSync("src/terminal/SessionTerminal.tsx", "utf8");
const theme = readFileSync("src/styles/theme.css", "utf8");

// GEOMETRY 1: preview grid is capped, not unbounded (perf) and not fixed
// (fidelity). Both bounds must exist where the dims are clamped.
ok("preview geometry is clamped to a sane cap",
  /const PREVIEW_MAX_COLS = \d+/.test(conns) &&
  /const PREVIEW_MAX_ROWS = \d+/.test(conns) &&
  conns.includes("clampPreviewDims"));
ok("clamp bounds both axes",
  /Math\.max\(20,[\s\S]{0,80}Math\.min\(PREVIEW_MAX_COLS/.test(conns) &&
  /Math\.max\(5,[\s\S]{0,80}Math\.min\(PREVIEW_MAX_ROWS/.test(conns));

// GEOMETRY 2: the real surface feeds its grid to the preview registry —
// both on attach-time estimation and on every accepted fit.
ok("surface records its real grid for previews",
  conns.includes("export function noteSurfaceDims") &&
  (surface.match(/noteSurfaceDims\(/g) || []).length >= 1);
ok("attach-time dims estimate scales with the font size",
  readFileSync("src/components/TerminalOverlay.tsx", "utf8").includes("noteSurfaceFontSize(fontPx)") &&
  /const cellW = TERMINAL_CELL_W_RATIO \* fontPx/.test(readFileSync("src/components/TerminalOverlay.tsx", "utf8")) &&
  // The ratio must come from the shared constant so the live surface, the
  // preview emulator and this estimate cannot drift apart.
  /export const TERMINAL_CELL_W_RATIO = 0\.6/.test(conns) &&
  /const cellH = TERMINAL_LINE_HEIGHT \* fontPx/.test(readFileSync("src/components/TerminalOverlay.tsx", "utf8")));

// GEOMETRY 3: dim changes rebuild the emulator; nothing calls resize on the
// preview terminal (that is the smear bug).
ok("preview rebuilds on geometry change instead of resizing",
  /!sameDims\(state\.dims, dims\)/.test(conns) &&
  /disposePreviewTerminal\(localId\)[\s\S]{0,120}state = undefined/.test(conns));
ok("preview terminal is never resized in place",
  !/terminal\.resize\(/.test(conns));
ok("persisted dims survive reloads",
  conns.includes("PREVIEW_DIMS_KEY") &&
  conns.includes("loadPersistedDims") &&
  conns.includes("persistDimsSoon"));

// REMOUNT: xterm.open is a no-op on an already-opened terminal, so the card
// must re-home the live element instead of assuming open() moved it.
ok("card remount re-homes the live xterm element",
  /el\.parentElement !== host\) host\.appendChild\(el\)/.test(conns) &&
  conns.includes("xterm.open() is a documented no-op"));

// FIT: the miniature is a geometric shrink of the real grid (transform),
// measured from the actual screen element — not a tiny font.
ok("screen fit uses a measured CSS transform",
  card.includes('querySelector<HTMLElement>(".xterm-screen")') &&
  /screen\.style\.transform = `scale\(/.test(card) &&
  /PREVIEW_VIEWPORT_HEIGHT \/ sh/.test(card));
ok("theme scales via transform-origin, not a 5px font",
  theme.includes("transform-origin: top left") &&
  !/\.card-term \{[\s\S]{0,80}font-size: 5px/.test(theme));

// FRAME READINESS: an unparsed replay must not surface as an empty screen.
ok("unparsed rebuild never surfaces as a blank screen frame",
  /if \(!state\.ready\)[\s\S]{0,160}return null/.test(conns));

// FROZEN SNAPSHOT: v2 header carries the grid; the legacy plain key is still
// read so old snapshots keep rendering.
ok("frozen screen persists cols x rows with the lines",
  conns.includes("still-frozen:1 ") &&
  /still-frozen:1 \$\{state\.dims\.cols\}x\$\{state\.dims\.rows\}/.test(conns));
ok("legacy frozen snapshots still parse",
  conns.includes("PREVIEW_FROZEN_PREFIX + localId") &&
  conns.includes("parseFrozenScreen"));

// NEGATIVE: no fixed-size preview grid constants may linger (64x8 was the
// reflowing miniature that no longer matches the surface).
ok("no lingering fixed preview grid",
  !/const PREVIEW_COLS = 64/.test(conns) &&
  !/const PREVIEW_ROWS = 8/.test(conns));

console.log(`\n==== ${pass}/${pass + fail} preview-card regression checks passed ====`);
process.exit(fail ? 1 : 0);
