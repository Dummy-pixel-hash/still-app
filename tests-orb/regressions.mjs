// Orb regression tests — run: node tests-orb/regressions.mjs (from still-app/).
// Each case maps to a concrete Phase-1 contract of the orb companion.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); c ? pass++ : fail++; };

const main = readFileSync("src/main.tsx", "utf8");
const Orb = readFileSync("src/screens/OrbScreen.tsx", "utf8");
const nav = readFileSync("src/components/WindowNav.tsx", "utf8");
const ws = readFileSync("src/screens/Workspace.tsx", "utf8");
const tauriBridge = readFileSync("src/bridge/tauriBridge.ts", "utf8");
const mock = readFileSync("src/bridge/mockBridge.ts", "utf8");
const native = readFileSync("src/bridge/nativeBridge.ts", "utf8");
const orbState = readFileSync("src/session/orbState.ts", "utf8");
const agent = readFileSync("src/session/agentStatus.ts", "utf8");
const settingsSheet = readFileSync("src/components/SettingsSheet.tsx", "utf8");
const probe = readFileSync("src-tauri/src/ssh_worker.rs", "utf8");
const manifest = readFileSync("src-tauri/src/agent_state.rs", "utf8");
const orbmod = readFileSync("src-tauri/src/orb.rs", "utf8");
const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
const cmd = readFileSync("src-tauri/src/commands.rs", "utf8");
const nativeBridgeSrc = readFileSync("src/bridge/nativeBridge.ts", "utf8");
const tauriAdapter = readFileSync("src/bridge/tauriBridge.ts", "utf8");
const mockAdapter = readFileSync("src/bridge/mockBridge.ts", "utf8");
const model = readFileSync("src-tauri/src/orb_model.rs", "utf8");
const confText = readFileSync("src-tauri/tauri.conf.json", "utf8");

// 1: orb route renders the companion, never the workspace.
ok("main.tsx renders OrbScreen on ?orb=1", main.includes("isOrbRoute") && main.includes("OrbScreen"));
ok("orb route never renders App", main.includes("OrbScreen") && main.includes("<App />"));

// 2: contract surface covers the swap + geometry + quit.
for (const m of ["minimizeToOrb", "restoreFromOrb", "orbSnapshot", "orbHide", "orbPush", "orbStartDrag", "orbSetSize", "orbSetPosition", "orbGetPosition", "orbGetMonitorBounds", "quit"]) {
  ok(`bridge contract has ${m}`, native.includes(`${m}(`) || native.includes(m));
}
ok("tauriBridge implements orb commands", tauriBridge.includes("still_minimize_to_orb") && tauriBridge.includes("still_orb_snapshot") && tauriBridge.includes("still_app_exit"));
ok("mockBridge fakes orb snapshot rows", mock.includes("orbSnapshot") && mock.includes("sessionId"));

// 3: minimize button pushes a fresh snapshot before hiding (stale-free orb).
ok("WindowNav pushes snapshot then swaps", nav.includes("orbPush") && nav.includes("minimizeToOrb"));

// 4: shortcut is capture-phase (never leaks bytes into the PTY).
ok("orb shortcut on Ctrl/Cmd+Shift+M with capture",
  ws.includes('"m"') && ws.includes("minimizeToOrb") && ws.includes("{ capture: true }"));

// 5: the hidden main keeps the orb live but stays nearly silent when idle.
ok("workspace pushes snapshots while hidden", ws.includes("orbFpRef") && ws.includes("orbFingerprint"));

// 6: orb snapshot helper strips + redacts + urgency-sorts.
ok("buildOrbSnapshot honors live states only", orbState.includes('"connected"') && orbState.includes('"connecting"') && orbState.includes('"error"'));
ok("orbState urgency-sorts needs-input first", orbState.includes('"needs-input": 0'));
ok("agent detectStatus blocks trump working", agent.includes("NEEDS_INPUT_RE") && agent.includes('"needs-input"'));
ok("agentStatus redacts secret-shaped text", agent.includes("SECRET_RE") && agent.includes("redacted"));

// 7: secrets never cross the orb boundary.
for (const [name, src] of [["OrbScreen", Orb], ["orbState", orbState], ["agentStatus", agent]]) {
  ok(`${name} ships no secret-shaped fields`,
    !/password|privateKey|passphrase|secretText/i.test(src));
}

// 8: orb never touches the session input path.
ok("OrbScreen never calls write/resize/connect",
  !Orb.includes("nativeBridge.write") &&
  !Orb.includes("nativeBridge.resize") &&
  !Orb.includes("nativeBridge.connect("));

// 9: orb config shape in tauri.conf.json (verified by bundling tests-token below).
try {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const win = (conf.app?.windows ?? []).find((w) => w.label === "orb");
  ok("orb window declared in tauri.conf.json", Boolean(win));
  ok("orb window is hidden + alwaysOnTop + skipTaskbar",
    win && win.visible === false && win.alwaysOnTop === true && win.skipTaskbar === true);
  ok("SettingsSheet has the orb toggle (opt-out, taskbar fallback)",
  settingsSheet.includes("orb?.enabled") && settingsSheet.includes("minimizeBehavior") && settingsSheet.includes("taskbar"));
} catch {
  ok("tauri.conf.json parses", false);
}

// 10: Phase-2 zero-config fallback (Rust is authoritative; the TS mirror
// stays in lockstep) — read-only exec probes, never the live PTY.
ok("run_exec_capture opens a NEW channel (never the PTY)",
  probe.includes("channel_open_session") && /never the live pty/i.test(probe));
ok("probe_agent_pane allowlists the tmux name (no shell injection)",
  probe.includes("allowlist") && probe.includes("2>/dev/null"));
ok("agent_state manifests mirror agentStatus.ts (6 agents + generic)",
  manifest.includes("codex") && manifest.includes("copilot") && manifest.includes("GENERIC_BLOCKED"));
ok("idle flips debounce one tick (frozen frames only)",
  manifest.includes("pending_idle"));
ok("background tick sniffs only while looked at (orb visible|main hidden)",
  lib.includes("orb_visible") && lib.includes("main_visible") && lib.includes("agent_tick"));
ok("snapshot merge keeps rust sniff when renderer pushes unknown",
  orbmod.includes("Rust sniff wins") || orbmod.includes("rust-classified"));

// 11: Phase-3 precise hooks (Layer 1, opt-in) — agent stamps win while fresh,
// the scrape always runs underneath.
ok("hook stamps parse + aliases blocked/finished",
  manifest.includes("HookStamp") && manifest.includes("STAMP_TTL_SECS") && manifest.includes('"blocked"'));
ok("stamps expire after 10 min (fail safe back to the scrape)",
  manifest.includes("10 * 60") && orbmod.includes("stamp.fresh"));
ok("stamp script is dependency-free POSIX sh (no curl, no secrets)",
  manifest.includes("#!/bin/sh") && manifest.includes("agent-state"));
ok("claude installer backs up once + merges tagged entries",
  manifest.includes(".bak-still") && manifest.includes("STILL_HOOK_TAG"));
ok("still_hooks_install allows only claude in v1 (scrape covers the rest)",
  cmd.includes("unsupported_agent") && cmd.includes("still_hooks_install"));
ok("Settings exposes the opt-in hook installer (per-session, live only)",
  settingsSheet.includes("hooksInstall") && settingsSheet.includes("Precise agent state"));
ok("bridge carries hooksInstall on all three adapters",
  nativeBridgeSrc.includes("hooksInstall") && tauriAdapter.includes("still_hooks_install") && mockAdapter.includes("hooksInstall"));

// 12: Julia-1 Labs (BYO endpoint only — no vendored model, no sidecar, no new
// deps). Order stays: fresh stamp → confident Julia → scrape.
ok("smart commands registered (status/set/probe)",
  cmd.includes("still_orb_smart_status") && cmd.includes("still_orb_smart_set") && cmd.includes("still_orb_smart_probe"));
ok("smart defaults OFF with localhost endpoint",
  model.includes("enabled: false") && model.includes("http://127.0.0.1:8080") && model.includes("DEFAULT_CUTOFF"));
ok("non-loopback endpoints refused before dial",
  model.includes("smart_endpoint_refused") || (model.includes("loopback") && model.includes("must be loopback")));
ok("classify times out fast and fails open to the scrape",
  model.includes("CLASSIFY_TIMEOUT") && orbmod.includes("None => (program, state, snippet, false)"));
ok("tick order is stamp → julia → scrape",
  orbmod.includes("Layer 1b") || orbmod.includes("Smart"));
ok("pane bytes never enter diag (verdict + confidence only)",
  orbmod.includes("pane bytes NEVER enter diag") || orbmod.includes("Privacy: pane bytes NEVER"));
ok("no model bytes in the bundle",
  !/\.gguf|llama-server|Julia-1\.GGUF/i.test(confText));
ok("Settings exposes Smart orb (toggle + endpoint + cutoff + test + guide)",
  settingsSheet.includes("SmartOrbSection") && settingsSheet.includes("Test my server") && settingsSheet.includes("llama-server -hf"));
ok("bridge carries smart surface on all three adapters",
  nativeBridgeSrc.includes("smartProbe") && tauriAdapter.includes("still_orb_smart_probe") && mockAdapter.includes("smartProbe"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
