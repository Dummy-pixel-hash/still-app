// M5 regression tests — run: node tests-m5/regressions.mjs (from still-app/).
// Guards the host-key verification contract in the renderer layer:
// Rust stays authoritative; the renderer never verifies or persists trust.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); c ? pass++ : fail++; };

const worker = readFileSync("src-tauri/src/ssh_worker.rs", "utf8");
const hostkeys = readFileSync("src-tauri/src/hostkeys.rs", "utf8");
const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
const core = readFileSync("src-tauri/src/core.rs", "utf8");
const nb = readFileSync("src/bridge/nativeBridge.ts", "utf8");
const tb = readFileSync("src/bridge/tauriBridge.ts", "utf8");
const mock = readFileSync("src/bridge/mockBridge.ts", "utf8");
const conns = readFileSync("src/session/connections.ts", "utf8");
const overlay = readFileSync("src/components/TerminalOverlay.tsx", "utf8");

// SECURITY 1: no unconditional host-key acceptance anywhere.
ok("worker no longer accepts all host keys",
  !/Ok\(true\)\s*\n?\s*\}\s*\n?\s*\}/.test(worker.split("struct StillClient")[1] ?? ""));
ok("no permissive host-key TODO gate remains",
  !worker.includes("accepted without pinning") && !worker.includes("production must pin/verify host keys"));
ok("host-key refusal carries typed codes",
  worker.includes("host_key_unknown:") && worker.includes("host_key_changed:"));
ok("unknown-key path still refuses (returns false to russh)",
  /Ok\(false\)/.test(worker));

// SECURITY 2: the renderer never persists or verifies host keys.
ok("trust store is Rust-owned (no renderer localStorage for host keys)",
  !conns.includes("localStorage") && !/localStorage[^\n]*known|known[^\n]*localStorage/.test(conns));
ok("renderer never writes host-key trust",
  !/localStorage\.setItem\([^)]*(hostKey|known_hosts|fingerprint)/i.test(conns + overlay));
ok("trust is granted through the typed bridge only",
  nb.includes("trustHost(") && tb.includes("still_trust_host"));

// SECURITY 3: mock/failing adapters cannot claim verification.
ok("mock bridge refuses host-key probing",
  mock.includes("unavailable in the renderer simulation"));
ok("mock bridge cannot grant trust",
  /async trustHost\(\)\s*\{\s*throw/.test(mock));

// SECURITY 4: secrets never cross into host-key plumbing.
ok("hostkeys.rs stores public keys only (no password/keyring fields)",
  !/password|passphrase|private_key|secret/i.test(hostkeys.replace(/\/\/.*$/gm, "")));
ok("still_trust_host never accepts a secret argument",
  /pub async fn still_trust_host\(args: TrustArgs\)/.test(commands));

// FUNCTIONAL: fingerprint + host/port context reach the UI.
ok("HostKeyPrompt carries fingerprint + endpoint + changed flag",
  core.includes("pub fingerprint: String") &&
  core.includes("pub port: u16") &&
  core.includes("pub changed: bool"));
ok("bridge exposes the unknown-host event",
  nb.includes("hostKeyPrompt") && conns.includes("hostKeyPrompt"));
ok("UI shows the fingerprint and both actions",
  overlay.includes("data-testid=\"host-fingerprint\"") &&
  overlay.includes("Trust this server") &&
  overlay.includes("Reject"));
ok("changed keys cannot be trusted from the dialog",
  overlay.includes("{!hostPrompt.changed && (") && overlay.includes("HOST KEY CHANGED"));

// INVARIANT: exactly one verification path (connect/reconnect/reattach).
ok("single verified handshake in the worker",
  (worker.match(/let verifier = VerifyClient \{/g) || []).length === 1 &&
  (worker.match(/impl client::Handler for VerifyClient/g) || []).length === 1);
ok("probe client is capture-only (never authenticates)",
  worker.includes("struct CaptureClient") && /struct CaptureClient[\s\S]*?Ok\(false\)/.test(worker));
ok("connect path has no unverified bypass",
  !/client::connect\([^)]*StillClient/.test(worker));

// UX BUGFIX: client-side errors must never leak into the PTY transcript.
// The terminal shows ONLY bytes from the remote SSH/tmux channel; host-key
// prompts and transport errors belong to Still's UI (state + dialog).
ok("error events are NOT injected into the terminal transcript",
  !conns.includes("TextEncoder") &&
  conns.includes("never to the remote PTY"));
ok("generic error panel is suppressed while a host-key prompt is active",
  overlay.includes("!hostPrompt && (state === \"disconnected\" || state === \"error\")"));

console.log(`\n==== ${pass}/${pass + fail} M5 regression checks passed ====`);
process.exit(fail ? 1 : 0);
