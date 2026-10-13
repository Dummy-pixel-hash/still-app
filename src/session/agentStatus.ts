// Still orb — agent state vocabulary + deterministic text-based detection.
//
// This is the RENDERER MIRROR used by the dev mock and CLI unit tests. In a
// production bundle the Rust `agent_state` layer is authoritative (it runs
// `tmux capture-pane` on its own channel, never through the live PTY). The
// rules here must stay in lockstep with the manifests there.
//
// Precedence for a single pane: needs-input > error > done > working >
// idle > unknown. Unknown is the honest fallback — a connected-but-quiet
// pane must NOT read as working (that old fallback turned the orb
// permanently red).

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

/**
 * Question-shaped signals: a permission verb PLUS question chrome (? at
 * line end, y/n, numbered options, ❯ selection) in the last ~8 lines.
 * Bare words ("approved", "error handling") must never trip this.
 */
const NEEDS_INPUT_RE: RegExp[] = [
  /\b(do you want to|do you trust|shall i|should i|confirm|approve|allow|trust|proceed|authorize|permission)[^.!?\n]{0,80}\?/i,
  /\(y\/n\)|\(Y\/n\)|\[y\/n\]|\[Y\/n\]/,
  /❯\s*1\.|^\s*1\.\s+(yes|allow|approve|proceed)/im,
  /▪\s*run\?/,
  /✋|action required/i,
  /awaiting (your )?(input|approval|confirmation|permission)/i,
]

/** Failure markers evaluated on the TAIL only (last ~6 lines), with
 *  negations ("no error", "0 errors", "error: 0") excluded. */
const ERROR_RE: RegExp[] = [
  /\berrors?\b/i,
  /\bfailed\b|\bfailure\b/i,
  /rate\s*limit/i,
  /auth(entication)?\s+fail/i,
  /\btraceback/i,
  /\bpanic\b/i,
]
const ERROR_NEG_RE: RegExp[] = [
  /\bno\s+errors?\b/i,
  /\b0\s+errors?\b/i,
  /errors?\s*[:=]\s*0\b/i,
  /\b0\s+failed\b/i,
  /\bno\s+failures?\b/i,
]

/** Finished markers: explicit done banners in the last ~4 lines. */
const DONE_RE: RegExp[] = [
  /✔\s*done/i,
  /\bdone in \d+(\.\d+)?s/i,
  /\btask (complete|completed|finished)\b/i,
  /\b(session|run) (complete|completed|finished)\b/i,
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
 * `stateHint` (e.g. the underlying SSH connection state) only maps
 * hard transport failure to error; it NEVER promotes quiet text to
 * working — unknown stays unknown so the orb stays dim, not red.
 */
export function detectStatus(lines: string[], stateHint?: string): AgentStatus {
  const qTail = lines.slice(-8).join("\n")
  const errTail = lines.slice(-6).join("\n")
  const workTail = lines.slice(-10).join("\n")
  const doneTail = lines.slice(-4).join("\n")

  // Needs-input wins: a blocked agent must never read as "working".
  if (NEEDS_INPUT_RE.some((re) => re.test(qTail))) return "needs-input"

  // Error: tail match without a negation on the same tail.
  if (
    ERROR_RE.some((re) => re.test(errTail)) &&
    !ERROR_NEG_RE.some((re) => re.test(errTail))
  )
    return "error"

  // Done: explicit finish banner with no spinner still spinning above it.
  if (DONE_RE.some((re) => re.test(doneTail))) {
    if (!/[⠁⠉⠙⠛⠹⣿]/.test(doneTail) && !/esc to interrupt/i.test(doneTail))
      return "done"
  }

  const workingChrome =
    /esc to interrupt/i.test(workTail) ||
    /working\s*\(/i.test(workTail) ||
    /[⏺✻✽✶✳ⓘ✦]/.test(workTail) ||
    /[⠁⠉⠙⠛⠹⣿]/.test(workTail) ||
    /⠋|thinking…|running…|reading files…/i.test(workTail)

  if (workingChrome) return "working"

  // A bare shell prompt (no agent chrome) at the tail => sitting idle.
  const last = lines.filter((l) => l.trim()).at(-1)?.trim() ?? ""
  const atPrompt =
    /^[❯›>$#](\s|$)/.test(last) ||
    /^\$\s*$/.test(last) ||
    /^❯\s*$/.test(last)
  if (atPrompt) return "idle"

  if (stateHint === "error") return "error"
  return "unknown"
}

/** Never leak secret-shaped text into a snippet/status payload. */
const SECRET_RE =
  /(sk-[a-zA-Z0-9]{12,}|ghp_[a-zA-Z0-9]{20,}|gsk_[a-zA-Z0-9]{12,}|xox[bpa]-[a-zA-Z0-9-]+|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

export function redactLine(line: string): string {
  if (SECRET_RE.test(line)) return "…(redacted)"
  return line
}
