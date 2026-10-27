import type {
  IBufferLine,
  IBufferRange,
  ILink,
  ILinkHandler,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm"

/**
 * Plain-text URL detection for terminal output.
 *
 * `www.` is accepted as a convenience and normalized to https. Only http(s)
 * survives normalization: OSC 8 hyperlinks can carry `javascript:`/`file:`
 * URIs, and a terminal never has a reason to hand those to the OS opener.
 */
export interface FoundLink {
  /** Index into the source string (inclusive). */
  start: number
  /** Index into the source string (exclusive). */
  end: number
  /** Normalized, opener-safe URL. */
  url: string
}

const MAX_URL_LENGTH = 8192
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

/** Strip sentence punctuation and unbalanced closing brackets from a URL. */
function trimTrailing(value: string): string {
  let end = value.length
  while (end > 0) {
    const last = value[end - 1]
    if (/[.,;:!?]/.test(last)) {
      end--
      continue
    }
    const open = PAIRS[last]
    if (open) {
      const candidate = value.slice(0, end)
      const opens = candidate.split(open).length - 1
      const closes = candidate.split(last).length - 1
      if (closes > opens) {
        end--
        continue
      }
    }
    break
  }
  return value.slice(0, end)
}

/** Validate an opener destination. Returns null for anything but http(s). */
export function normalizeExternalUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value || value.length > MAX_URL_LENGTH) return null
  // Control chars and spaces can smuggle extra command arguments through some
  // platform openers; a URL never needs them unencoded.
  if (/[\u0000-\u0020\u007f]/u.test(value)) return null
  const candidate = /^www\./i.test(value) ? `https://${value}` : value
  try {
    const url = new URL(candidate)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (!url.hostname) return null
    return url.href
  } catch {
    return null
  }
}

/** Find every safe URL in a line of terminal text. */
export function findLinks(text: string): FoundLink[] {
  const links: FoundLink[] = []
  const pattern = new RegExp(URL_PATTERN.source, "gi")
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const candidate = trimTrailing(match[0])
    if (!candidate) continue
    const url = normalizeExternalUrl(candidate)
    if (url) links.push({ start: match.index, end: match.index + candidate.length, url })
  }
  return links
}

interface CellMap {
  text: string
  /** Cell column (1-based) for each UTF-16 code unit in `text`. */
  starts: number[]
  /** Inclusive last cell column for each UTF-16 code unit in `text`. */
  ends: number[]
}

/** Flatten a buffer line into text plus a code-unit -> cell-column map. */
function cellsFor(line: IBufferLine, cols: number): CellMap {
  let text = ""
  const starts: number[] = []
  const ends: number[] = []
  const limit = Math.min(line.length, cols)
  for (let x = 0; x < limit; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    const width = cell.getWidth()
    // Width-0 cells are the right half of a wide glyph already emitted above.
    if (width === 0) continue
    const chars = cell.getChars() || " "
    text += chars
    for (let i = 0; i < chars.length; i++) {
      starts.push(x + 1)
      ends.push(x + width)
    }
  }
  while (text.endsWith(" ")) {
    text = text.slice(0, -1)
    starts.pop()
    ends.pop()
  }
  return { text, starts, ends }
}

/**
 * Add link detection to a session terminal.
 *
 * Plain URLs and OSC 8 hyperlinks both activate on Ctrl/Cmd+click (the
 * terminal convention) so ordinary clicks can still select text and reach a
 * mouse-tracking TUI. Text-decoration/pointer cursor are xterm's built-in
 * link decorations.
 */
export function bindTerminalLinks(
  terminal: Terminal,
  open: (url: string) => void,
): { dispose(): void } {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active
      const target = bufferLineNumber - 1
      if (target < 0 || target >= buffer.length || !buffer.getLine(target)) {
        callback(undefined)
        return
      }

      // A long URL wraps across buffer lines. Linkifier asks per line, so
      // answer with the whole logical (wrapped) line and let it pick the
      // range under the pointer.
      let first = target
      while (first > 0 && buffer.getLine(first)?.isWrapped) first--
      let last = target
      while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++

      let text = ""
      const starts: number[] = []
      const ends: number[] = []
      const rows: number[] = []
      for (let row = first; row <= last; row++) {
        const line = buffer.getLine(row)
        if (!line) continue
        const map = cellsFor(line, terminal.cols)
        text += map.text
        starts.push(...map.starts)
        ends.push(...map.ends)
        for (let i = 0; i < map.text.length; i++) rows.push(row + 1)
      }

      const links: ILink[] = []
      for (const found of findLinks(text)) {
        const start = starts[found.start]
        const end = ends[found.end - 1]
        const startRow = rows[found.start]
        const endRow = rows[found.end - 1]
        if (!start || !end || !startRow || !endRow) continue
        const range: IBufferRange = {
          start: { x: start, y: startRow },
          end: { x: end, y: endRow },
        }
        links.push({
          range,
          text: found.url,
          decorations: { underline: true, pointerCursor: true },
          activate(event) {
            if (!(event.ctrlKey || event.metaKey)) return
            open(found.url)
          },
        })
      }
      callback(links.length ? links : undefined)
    },
  }

  const registration = terminal.registerLinkProvider(provider)
  const handler: ILinkHandler = {
    activate(event, text) {
      if (!(event.ctrlKey || event.metaKey)) return
      const url = normalizeExternalUrl(text)
      if (url) open(url)
    },
  }
  const previous = terminal.options.linkHandler
  terminal.options.linkHandler = handler

  return {
    dispose() {
      registration.dispose()
      if (terminal.options.linkHandler === handler) {
        terminal.options.linkHandler = previous ?? null
      }
    },
  }
}
