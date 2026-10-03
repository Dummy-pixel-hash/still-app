// M6 regression tests — run: node tests-m6/regressions.mjs (from still-app/).
// Guards the connection-lifecycle fixes:
//
// FIX 1: a rejected nativeBridge.connect() must record error state, never
//   strand the session in "connecting", and never reject to callers.
// FIX 2: exactly one owner starts the initial connection (creation flow owns
//   it when a secret exists; the overlay auto-connect owns it otherwise).
// FIX 3: fast native HostKeyPrompt/Error/Status events emitted before the
//   frontend subscription registers must be reconciled explicitly — no
//   sleeps, no timing reliance, no host-key bypass.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); c ? pass++ : fail++; };
const count = (src, sub) => src.split(sub).length - 1;

const conns = readFileSync("src/session/connections.ts", "utf8");
const overlay = readFileSync("src/components/TerminalOverlay.tsx", "utf8");
const workspace = readFileSync("src/screens/Workspace.tsx", "utf8");
const mock = readFileSync("src/bridge/mockBridge.ts", "utf8");
const types = readFileSync("src/types/index.ts", "utf8");
const card = readFileSync("src/components/SessionCard.tsx", "utf8");

// --- FIX 1: rejection-safe connect ------------------------------------------
ok("connect() rejection is caught inside connectSession",
  /try\s*\{\s*\n?\s*res\s*=\s*await nativeBridge\.connect/.test(conns) &&
  conns.includes("formatSetupError"));
ok("rejected connect records error state with typed lastError",
  conns.includes("formatSetupError(e)") &&
  conns.includes("never strand in") &&
  /state:\s*"error",\s*\n?\s*lastError:\s*formatSetupError\(e\)/.test(conns));
ok("rejected connect clears nativeId (no phantom session)",
  /lastError:\s*formatSetupError\(e\),\s*\n?\s*nativeId:\s*null/.test(conns));
ok("setup errors keep the typed [code] message format",
  conns.includes("[connect_failed]") &&
  conns.includes("code") && conns.includes("message"));
ok("failed subscribe reaps the orphan native session and reports",
  conns.includes("reapOrphan(res.sessionId)") &&
  count(conns, "reapOrphan(res.sessionId)") >= 2);
ok("error path still never touches the terminal fan-out",
  count(conns, "sessionDataListeners.get(localId)?.forEach") === 1 &&
  conns.includes("must NOT be injected into sessionDataListeners"));
ok("overlay doConnect is rejection-safe (no unhandled rejections)",
  /await reconnectSession\(req\)[\s\S]*?catch[\s\S]*?finally/.test(overlay) &&
  overlay.includes("no unhandled promise rejections"));

// --- FIX 2: single owner -----------------------------------------------------
ok("creation flow has exactly one direct connect call site",
  count(workspace, "await connectSession(") === 1);
ok("overlay auto-connect yields to an in-flight/owned attempt",
  overlay.includes("isConnectPending(session.id)") &&
  overlay.includes("Single-owner rule"));
ok("registry exposes attempt-pending ownership",
  conns.includes("export function isConnectPending"));
ok("overlapping attempts are epoch-superseded (newest wins, loser reaps)",
  conns.includes("beginAttempt") &&
  conns.includes("invalidateAttempts") &&
  conns.includes("isCurrent") &&
  conns.includes("attemptEpoch"));
ok("explicit disconnect invalidates in-flight attempts (no resurrection)",
  /invalidateAttempts\(localId\)/.test(conns) &&
  conns.includes("never resurrect a session"));
ok("no arbitrary delay hacks in the connection path",
  !conns.includes("setTimeout") && !conns.includes("setInterval"));

// --- FIX 3: subscription race reconciliation ---------------------------------
ok("post-subscribe reconciliation reads authoritative status",
  conns.includes("await nativeBridge.status(res.sessionId)") &&
  conns.includes("adoptAuthoritativeStatus"));
const adoptBody = conns.split("function adoptAuthoritativeStatus")[1].split("export interface ConnectRequest")[0];
ok("reconciliation adopts only terminal/live states, never clobbers",
  adoptBody.includes('wireStatus === "closed"') &&
  adoptBody.includes('wireStatus === "live"') &&
  adoptBody.includes('wireStatus === "error"') &&
  !adoptBody.includes('state: "connecting"') &&
  conns.includes("could clobber the live"));
ok("stale listeners stay silent after supersede",
  conns.includes("attemptEpoch.get(localId) !== epoch"));
ok("reconciliation documents why subscribe-first is impossible",
  conns.includes("server-generated session id") &&
  conns.includes("no replay"));

// --- CF-4: explicit disconnect leaves clean state ------------------------------
const discBody = conns.split("export async function disconnectSession")[1].split("export async function reconnectSession")[0];
ok("explicit disconnect clears stale prompt and error",
  discBody.includes("hostKeyPrompt: null") &&
  discBody.includes("lastError: null") &&
  discBody.includes("genuinely clean state"));
ok("disconnect still invalidates in-flight attempts first",
  discBody.indexOf("invalidateAttempts(localId)") < discBody.indexOf("setEntry(localId"));

// --- CF-5: changed-key recovery -------------------------------------------------
const forgetBody = conns.split("export async function forgetStoredHostKey")[1].split("export interface ConnectRequest")[0];
ok("registry exposes explicit stored-key removal",
  conns.includes("export async function forgetStoredHostKey") &&
  forgetBody.includes("nativeBridge.forgetHost(host, port)"));
ok("forget clears the prompt and points at retry-as-unknown (never trusts)",
  forgetBody.includes("hostKeyPrompt: null") &&
  forgetBody.includes("host_key_forgotten") &&
  !forgetBody.includes("trustHost") &&
  forgetBody.includes("Trust is still required"));
const forgetCb = overlay.split("forgetStoredKey = useCallback")[1].split("}, [session, hostPrompt, forgetBusy])")[0];
ok("changed-key dialog offers removal, keeps Trust hidden",
  overlay.includes("Remove stored key") &&
  overlay.includes("void forgetStoredKey()") &&
  overlay.includes("forgetBusy") &&
  !forgetCb.includes("trustHost("));
ok("changed-key Trust button still gated to unknown hosts only",
  overlay.includes("{!hostPrompt.changed && ("));

// --- CF-6: transcript lifecycle --------------------------------------------------
ok("explicit removal frees all local registry state",
  conns.includes("export async function releaseSession") &&
  conns.includes("clearTranscript(localId)") &&
  conns.includes("entries.delete(localId)") &&
  conns.includes("sessionDataListeners.delete(localId)") &&
  conns.includes("announcedLengths.delete(localId)"));
ok("clearTranscript is finally wired (no longer dead)",
  count(conns, "clearTranscript(") >= 2);
const remove = readFileSync("src/components/RemoveDialog.tsx", "utf8");
ok("both removal paths release (dialog + direct)",
  remove.includes("releaseSession(session.id)") &&
  !remove.includes("disconnectSession") &&
  workspace.includes("releaseSession(sess.id)"));
const term = readFileSync("src/terminal/SessionTerminal.tsx", "utf8");
ok("reattach marker gated on transcript growth (no stacking on reopen)",
  term.includes("needsReattachMarker(localRef.current)") &&
  count(term, "noteTranscriptRendered(localRef.current)") === 2);
ok("mock disconnect notifies before dropping the channel",
  mock.indexOf('emit(sessionId, { type: "status", status: "disconnected" })') !== -1 &&
  mock.indexOf('emit(sessionId, { type: "status", status: "disconnected" })') <
    mock.indexOf("sessionSubscribers.delete(sessionId)"));

// --- Dead "reconnecting" state ---------------------------------------------------
ok("dead reconnecting state fully removed (nothing ever emitted it)",
  !/reconnecting/.test(conns + types + card));

console.log(`\n==== ${pass}/${pass + fail} M6 regression checks passed ====`);
process.exit(fail ? 1 : 0);