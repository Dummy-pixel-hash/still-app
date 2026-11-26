/** Tauri rejects with serialized StillError objects, not necessarily Error. */
export function nativeErrorMessage(failure: unknown, fallback: string): string {
  if (failure instanceof Error && failure.message.trim()) return failure.message
  if (typeof failure === "string" && failure.trim()) return failure
  if (failure && typeof failure === "object" && "message" in failure && typeof failure.message === "string" && failure.message.trim()) return failure.message
  return fallback
}

export interface ErrorText {
  /** One short, plain sentence that is safe to show in a single line. */
  summary: string
  /** The untouched original, only when it carries more than the summary. */
  detail?: string
}

const SUMMARY_LIMIT = 160
const STACK_LINE = /^(?:at\s|\s*File ")|^[-=~^_*]{3,}$/
const LEADING_CODE = /^\[[\w.:-]+\]\s*/
const LEADING_ERROR = /^(?:uncaught\s+)?(?:[A-Z]\w*Error|[Ee]rror|Exception|[Ff]atal)\s*:\s*/

/** Drops parenthesised asides that are technical noise: OS error codes, nested causes and long chains. */
function stripNoisyParentheticals(text: string): { text: string; removed: boolean } {
  let out = "", depth = 0, start = -1, removed = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "(") { if (depth++ === 0) start = i; continue }
    if (ch === ")" && depth > 0) {
      if (--depth === 0) {
        const inner = text.slice(start + 1, i)
        if (/os error|error|errno|code\s*[-\d]|:/i.test(inner) || inner.length > 40) removed = true
        else out += `(${inner})`
      }
      continue
    }
    if (depth === 0) out += ch
  }
  // An unbalanced "(" keeps the rest of the text rather than losing it.
  if (depth > 0) out += text.slice(start)
  return { text: out, removed }
}

/**
 * Splits a raw failure (stderr, OS errors, stack traces, `[code] message`)
 * into a calm one-line summary and the original text for a Details disclosure.
 * Display-only: callers must keep the raw value for logic such as code checks.
 */
export function splitErrorText(raw: string | null | undefined, fallback = "Something went wrong."): ErrorText {
  const full = String(raw ?? "").replace(/\r\n?/g, "\n").trim()
  if (!full) return { summary: fallback }
  const lines = full.split("\n").map(line => line.trim()).filter(Boolean)
  const first = lines.find(line => !STACK_LINE.test(line)) ?? lines[0]
  const { text, removed } = stripNoisyParentheticals(first.replace(LEADING_CODE, "").replace(LEADING_ERROR, ""))
  let summary = text.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/:$/, ".").replace(/\.{2,}$/, ".").trim()
  if (!summary) summary = fallback
  summary = summary[0].toUpperCase() + summary.slice(1)
  let truncated = false
  if (summary.length > SUMMARY_LIMIT) {
    const cut = summary.slice(0, SUMMARY_LIMIT - 1)
    const space = cut.lastIndexOf(" ")
    summary = `${(space > SUMMARY_LIMIT / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}…`
    truncated = true
  }
  return lines.length > 1 || removed || truncated ? { summary, detail: full } : { summary }
}
