// Still orb — agent state vocabulary + deterministic text-based detection.
//
// This is the RENDERER MIRROR used by the dev mock and CLI unit tests. In a
// production bundle the Rust `agent_state` layer is authoritative (it runs
// `tmux capture-pane` on its own channel, never through the live PTY). The
// rules here must stay in lockstep with the manifests there.
//
// Detection is intentionally small and false-positive-averse: a couple of
// high-signal keywords beat a sprawling regex table. Precedence for a single
// pane: needs-input > error > working > idle > unknown.

import type { AgentStatus } from "../bridge/nativeBridge"

export type AgentProgram =
  | "claude"
  | "codex"
  | "opencode"
  | "pi"
  | "gemini"
  | "copilot"
  | "shell"
  | "unknown"

/** Keyword signals (case-insensitive) that the agent is blocked on the user. */
const NEEDS_INPUT_RE: RegExp[] = [
  /approve\??/,
  /allow\??/,
  /trust\??/,
  /proceed\??/,
  /\(y\/n\)/,
  /permission\??/,
  /authorize\b/,
  /action required/i,
  /awaiting (your )?(input|approval|confirmation|permission)/i,
]

/** High-signal failure markers — shown as `error`, not swallowed. */
const ERROR_RE: RegExp[] = [
  /\berror(s)?\b/i,
  /\bfail(ed|ure)?\b/i,
  /rate\s*limit/i,
  /auth(entication)?\s+fail/i,
  /\btraceback/i,
  /panic\b/i,
]

/**
 * Which coding agent the pane seems to be running, from the pane command or
 * its terminal title. Best-effort; `unknown` is the safe default.
 */
export function detectProgram(
  paneCommand: string | undefined,
  paneTitle: string | undefined,
): AgentProgram {
  const hay = `${paneCommand ?? ""} ${paneTitle ?? ""}`.toLowerCase()
  if (/claude/.test(hay)) return "claude"
  if (/codex/.test(hay)) return "codex"
  if (/opencode/.test(hay)) return "opencode"
  if (/(^|[^a-z])pi($|[^a-z])/.test(hay) || /pscale|pi-\d/.test(hay)) return "pi"
  if (/gemini/.test(hay)) return "gemini"
  if (/copilot/.test(hay)) return "copilot"
  return "unknown"
}

/** Pick the last meaningful line of the pane (newest UI output) as snippet. */
export function pickSnippet(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    // Skip pure chrome: box-drawing borders and lone prompt glyphs add noise.
    if (/^[─━╰╭│┌└┐┘├┤]+[─━│╭╮╰╯]*$/.test(line)) continue
    if (/^[❯›>$\u0023]+\s*$/.test(line)) continue
    return line.slice(0, 80)
  }
  return ""
}

/**
 * Classify a pane's latest lines into the shared orb state vocabulary.
 * `stateHint` (e.g. the underlying SSH connection state) is a low-priority
 * tiebreaker used only when the text is inconclusive.
 */
export function detectStatus(lines: string[], stateHint?: string): AgentStatus {
  const tail = lines.slice(-20).join("\n")
  const low = tail.toLowerCase()

  // Needs-input wins: a blocked agent must never read as "working".
  if (NEEDS_INPUT_RE.some((re) => re.test(low))) return "needs-input"
  if (ERROR_RE.some((re) => re.test(low))) return "error"

  const last = lines[lines.length - 1]?.trim() ?? ""
  const workingChrome =
    /working|esc to interrupt|interrupt( |$)/i.test(tail) ||
    /⠁|⠉|⠙|⠛|⠹|⣿/.test(tail) // braille spinners survive text extraction

  // A bare shell prompt (no agent chrome) at the tail => sitting idle.
  const atPrompt = /^[❯›>$#][^❯$#]?/.test(last) || /^\$\s*$/.test(last)

  if (workingChrome) return "working"
  if (atPrompt && !/[^ ]/.exec(tail.slice(-12))) return "idle"

  if (stateHint === "error") return "error"
  if (stateHint === "connecting" || stateHint === "connected") return "working"
  return "unknown"
}

/** Never leak secret-shaped text into a snippet/status payload. */
const SECRET_RE =
  /(sk-[a-zA-Z0-9]{12,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

export function redactLine(line: string): string {
  if (SECRET_RE.test(line)) return "…(redacted)"
  return line
}
