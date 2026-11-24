import type { TerminalTheme } from "./appearance"

/**
 * A tiny strip showing a theme's background, foreground and accents. Purely
 * decorative: the theme's name always travels alongside it as text.
 */
export default function ThemeSwatch({ theme, size = "md" }: { theme: TerminalTheme; size?: "sm" | "md" }) {
  const c = theme.colors
  const dot = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center gap-[3px] rounded-md border border-white/15 ${size === "sm" ? "px-1 py-0.5" : "px-1.5 py-1"}`}
      style={{ background: c.background }}
    >
      {[c.foreground, c.red, c.green, c.blue].map((color, i) => (
        <span key={i} className={`${dot} rounded-full`} style={{ background: color }} />
      ))}
    </span>
  )
}
