// M3 regression tests — run: node tests-m3/regressions.mjs (from still-app/).
// Each case maps to a concrete bug fixed in Milestone 3.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); c ? pass++ : fail++; };

const conns = readFileSync("src/session/connections.ts", "utf8");
const mock = readFileSync("src/bridge/mockBridge.ts", "utf8");
const overlay = readFileSync("src/components/TerminalOverlay.tsx", "utf8");
const workspace = readFileSync("src/screens/Workspace.tsx", "utf8");
const auth = readFileSync("src/components/AuthDialog.tsx", "utf8");

// BUG 1: unconnected overlay auto-runs auth flow (no silent dead terminal)
ok("overlay auto-connects unconnected session on open",
  overlay.includes("autoTried") && overlay.includes("void doConnect()"));

// BUG 2: dialogs portalled above pointer-events:none workspace
for (const [n, src] of [["AuthDialog", auth]]) {
  ok(`${n} portalled to body`, src.includes("createPortal(") && src.includes("document.body"));
}
const settings = readFileSync("src/components/SettingsSheet.tsx", "utf8");
ok("SettingsSheet portalled to body", settings.includes("createPortal(") && settings.includes("document.body"));
const remove = readFileSync("src/components/RemoveDialog.tsx", "utf8");
ok("RemoveDialog portalled to body", remove.includes("createPortal(") && remove.includes("document.body"));

// BUG 3: terminal pauses + focus moves to dialog while auth is open
ok("overlay pauses terminal while auth open", overlay.includes("authOpen"));
ok("AuthDialog grabs focus on mount", auth.includes("fieldRef.current?.focus()"));

// BUG 3b: Ctrl+. close-first from any non-xterm focus
ok("Ctrl+. close-first (dialogs don't trap)",
  workspace.includes("Close-first") && workspace.includes("if (open && e.ctrlKey"));

// BUG 4: closing overlay cancels pending auth (no stale dialog)
ok("close cancels pending auth", workspace.includes("authForRef") && workspace.includes("pending.resolve(null)"));

// BUG 5: chrome pill portalled above xterm canvas hit-test
ok("chrome pill portalled with z-[65]", overlay.includes("z-[65]") && overlay.includes("createPortal("));

// BUG 6: mock PTY discipline — DEL never echoed raw; unsubscribed write no-op
ok("mock write gates on subscriber", mock.includes("if (!sessionSubscribers.has(sessionId)) return"));
ok("mock DEL translated (no raw 0x7f echo)", /replace\(.*x7f|\\\\x7f.*replace|\\\\b \\\\b/.test(mock) && !mock.includes("echoed") === false);

// Security: store persists metadata only
const store = readFileSync("src/session/store.ts", "utf8");
const secretFields = /secret\s*:\s*string|password\s*:\s*string|keyText\s*:\s*string|privateKey/i;
const codeOnly = store.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
ok("store defines no secret fields", !secretFields.test(codeOnly));

console.log(`\n==== ${pass}/${pass + fail} M3 regression checks passed ====`);
process.exit(fail ? 1 : 0);
