// Pure data + fuzzy matching for the command palette (no React).

export type PaletteGroup = "Sessions" | "Actions" | "Appearance"

export interface PaletteCommand {
  id: string
  group: PaletteGroup
  label: string
  /** Secondary text (host, shortcut hint). */
  hint?: string
  keywords?: string
  run: () => void
}

/** Subsequence match score; null = no match. Higher is better. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) return 1000 - at - (t.length - q.length) * 0.1 + (at === 0 ? 50 : 0)
  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    if (ch === " ") continue
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    streak = found === ti ? streak + 1 : 0
    score += 10 + streak * 5 - Math.min(9, found - ti)
    ti = found + 1
  }
  return score
}

const ORDER: PaletteGroup[] = ["Sessions", "Actions", "Appearance"]

/** Filter and rank; groups keep a fixed order, best match first within each. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const scored: { c: PaletteCommand; s: number; i: number }[] = []
  commands.forEach((c, i) => {
    const s = fuzzyScore(query, `${c.label} ${c.keywords ?? ""} ${c.hint ?? ""}`)
    if (s !== null) scored.push({ c, s: fuzzyScore(query, c.label) ?? s - 200, i })
  })
  return scored
    .sort((a, b) => ORDER.indexOf(a.c.group) - ORDER.indexOf(b.c.group) || b.s - a.s || a.i - b.i)
    .map((x) => x.c)
}
