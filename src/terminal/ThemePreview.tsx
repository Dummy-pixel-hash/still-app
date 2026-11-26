import type { TerminalTheme } from "./appearance"

/**
 * Live miniature terminal drawn from a theme's palette, font size and cursor
 * style. Purely presentational; used by Settings (default theme, theme editor).
 */
export default function ThemePreview({
  theme,
  fontSize,
  cursorStyle,
  label,
}: {
  theme: TerminalTheme
  fontSize: number
  cursorStyle: "block" | "underline" | "bar"
  /** Accessible name; defaults to a description of the settings shown. */
  label?: string
}) {
  const c = theme.colors
  const cursorStyleProps =
    cursorStyle === "block"
      ? { background: c.cursor, width: "0.6em" }
      : cursorStyle === "underline"
        ? { borderBottom: `2px solid ${c.cursor}`, width: "0.6em" }
        : { background: c.cursor, width: 2 }
  return (
    <div
      role="img"
      aria-label={label ?? `Terminal preview, ${theme.name}, ${fontSize}px ${cursorStyle} cursor`}
      className="mt-3 overflow-hidden rounded-xl border border-white/[0.07] px-4 py-3"
      style={{ background: c.background }}
    >
      <div className="font-mono leading-[1.5]" style={{ fontSize: `${fontSize}px`, color: c.foreground }}>
        <div className="truncate">
          <span style={{ color: c.red }}>deploy</span>
          <span style={{ color: c.brightBlack }}>@prod-fra-02</span>{" "}
          <span style={{ color: c.blue }}>~</span>
        </div>
        <div className="flex items-center gap-0 truncate">
          <span className="shrink-0" style={{ color: c.green }}>$&nbsp;</span>
          <span className="truncate">nvim main.rs</span>
          <span
            className="cursor-blink ml-0.5 inline-block h-[1em] shrink-0"
            style={cursorStyleProps}
          />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 truncate">
          <span style={{ color: c.yellow }}>warn</span>
          <span style={{ color: c.cyan }}>info</span>
          <span style={{ color: c.magenta }}>debug</span>
          <span style={{ color: c.brightGreen }}>ok</span>
          <span style={{ color: c.brightRed }}>fail</span>
        </div>
      </div>
    </div>
  )
}
