// Terminal appearance model: themes, font limits, normalizers, contrast helpers
// and the single resolver that turns (session override, app default) into the
// values xterm and the card previews consume.
//
// IMPORTANT: this file has TYPE-ONLY imports. tests-terminal/appearance.test.mjs
// transpiles it standalone with the TypeScript API, so no relative runtime
// imports may be added here. Themes are renderer-only data: they never enter
// ConnectRequest and never reach Rust.

import type { ITheme } from "@xterm/xterm"
import type { AppSettings, Session, TerminalPrefs } from "../types"

// --- font limits ---------------------------------------------------------------

export const FONT_MIN = 10
export const FONT_MAX = 24
export const FONT_DEFAULT = 14

export function clampFontSize(value: unknown, fallback = FONT_DEFAULT): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)))
}

// --- types ----------------------------------------------------------------------

export const ANSI_SLOTS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const
export type AnsiSlot = (typeof ANSI_SLOTS)[number]

export const BASE_SLOTS = ["background", "foreground", "cursor", "cursorAccent", "selectionBackground"] as const
export type BaseSlot = (typeof BASE_SLOTS)[number]

export type PaletteSlot = BaseSlot | AnsiSlot
export const PALETTE_SLOTS: readonly PaletteSlot[] = [...BASE_SLOTS, ...ANSI_SLOTS]

export type TerminalPalette = Record<PaletteSlot, string>

export interface TerminalTheme {
  id: string
  name: string
  kind: "dark" | "light"
  colors: TerminalPalette
  builtIn?: boolean
  /** Preset this custom theme was duplicated from (fallback for bad slots). */
  basedOn?: string
  /** Colour for card preview text; derived from the palette when absent. */
  previewForeground?: string
}

export type CursorBlinkPref = "auto" | "on" | "off"
export type ContrastPref = "auto" | 1 | 3 | 4.5 | 7
export const CONTRAST_CHOICES: readonly ContrastPref[] = ["auto", 1, 3, 4.5, 7]

export interface AppearanceEnv {
  reducedMotion: boolean
  moreContrast: boolean
}

export const DEFAULT_ENV: AppearanceEnv = { reducedMotion: false, moreContrast: false }

// --- presets --------------------------------------------------------------------

const STILL_COLORS: TerminalPalette = {
  background: "#08080a",
  foreground: "#ded9dd",
  cursor: "#ff5a5a",
  cursorAccent: "#08080a",
  selectionBackground: "#8f2a2a66",
  black: "#08080a",
  brightBlack: "#777078",
  red: "#ff5a5a",
  brightRed: "#ff7777",
  green: "#91b587",
  brightGreen: "#acd19f",
  yellow: "#d5aa82",
  brightYellow: "#e7bf98",
  blue: "#9a96b8",
  brightBlue: "#b3afd0",
  magenta: "#b89ab8",
  brightMagenta: "#cdb0cd",
  cyan: "#8eadb2",
  brightCyan: "#a5c4c9",
  white: "#d7d2d6",
  brightWhite: "#f4f0f2",
}

export const STILL_THEME_ID = "still"

export const PRESET_THEMES: readonly TerminalTheme[] = [
  {
    id: STILL_THEME_ID,
    name: "Still",
    kind: "dark",
    builtIn: true,
    previewForeground: "#b0aab8",
    colors: STILL_COLORS,
  },
  {
    id: "still-contrast",
    name: "Still high contrast",
    kind: "dark",
    builtIn: true,
    colors: {
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffe14d",
      cursorAccent: "#000000",
      selectionBackground: "#ffffff55",
      black: "#9a9a9a",
      brightBlack: "#b4b4b4",
      red: "#ff8a8a",
      brightRed: "#ffb0b0",
      green: "#8aff9a",
      brightGreen: "#b4ffbf",
      yellow: "#ffe14d",
      brightYellow: "#fff08a",
      blue: "#9ab8ff",
      brightBlue: "#bcd0ff",
      magenta: "#ff9aff",
      brightMagenta: "#ffbcff",
      cyan: "#7af0ff",
      brightCyan: "#aaf6ff",
      white: "#e6e6e6",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "paper",
    name: "Paper",
    kind: "light",
    builtIn: true,
    colors: {
      background: "#f6f3ee",
      foreground: "#2b2830",
      cursor: "#b3261e",
      cursorAccent: "#f6f3ee",
      selectionBackground: "#b3261e33",
      black: "#2b2830",
      brightBlack: "#5a5560",
      red: "#b3261e",
      brightRed: "#c93a30",
      green: "#2f6f3a",
      brightGreen: "#3a8048",
      yellow: "#8a5a00",
      brightYellow: "#9a6a10",
      blue: "#2a5db0",
      brightBlue: "#3a70c8",
      magenta: "#8a3a9a",
      brightMagenta: "#a04cb0",
      cyan: "#1c6f78",
      brightCyan: "#2a808a",
      white: "#6b6670",
      brightWhite: "#1a181d",
    },
  },
  {
    id: "tide",
    name: "Tide",
    kind: "dark",
    builtIn: true,
    colors: {
      background: "#0a1319",
      foreground: "#cfe0e6",
      cursor: "#4fd1c5",
      cursorAccent: "#0a1319",
      selectionBackground: "#1f5f7a80",
      black: "#0a1319",
      brightBlack: "#5b7480",
      red: "#ff7a7a",
      brightRed: "#ff9c9c",
      green: "#7fd6a0",
      brightGreen: "#a0ebbb",
      yellow: "#e6c36a",
      brightYellow: "#f3d98f",
      blue: "#6fb1ff",
      brightBlue: "#96c8ff",
      magenta: "#c79bff",
      brightMagenta: "#dbbaff",
      cyan: "#5fd7e6",
      brightCyan: "#8ae9f3",
      white: "#cfe0e6",
      brightWhite: "#f2fafc",
    },
  },
  {
    id: "moss",
    name: "Moss",
    kind: "dark",
    builtIn: true,
    colors: {
      background: "#0c130d",
      foreground: "#d2dccb",
      cursor: "#b5d36b",
      cursorAccent: "#0c130d",
      selectionBackground: "#4a6b2f80",
      black: "#0c130d",
      brightBlack: "#62745c",
      red: "#e9807a",
      brightRed: "#f5a29d",
      green: "#9bd07a",
      brightGreen: "#b9e49b",
      yellow: "#d9c06a",
      brightYellow: "#ead98e",
      blue: "#7fb0d9",
      brightBlue: "#a2c9e8",
      magenta: "#c294c9",
      brightMagenta: "#d9b4df",
      cyan: "#76c8b0",
      brightCyan: "#9ae0cb",
      white: "#d2dccb",
      brightWhite: "#f1f6ec",
    },
  },
  {
    id: "dusk",
    name: "Dusk",
    kind: "dark",
    builtIn: true,
    colors: {
      background: "#130f1b",
      foreground: "#ddd5e8",
      cursor: "#ff9ec7",
      cursorAccent: "#130f1b",
      selectionBackground: "#6b3fa080",
      black: "#130f1b",
      brightBlack: "#7a6e90",
      red: "#ff7f9a",
      brightRed: "#ffa3b7",
      green: "#8fd9a8",
      brightGreen: "#b1ecc3",
      yellow: "#f0c987",
      brightYellow: "#f8dda9",
      blue: "#8fa8ff",
      brightBlue: "#b3c4ff",
      magenta: "#d89bff",
      brightMagenta: "#e8bdff",
      cyan: "#7fd8e0",
      brightCyan: "#a5ebf0",
      white: "#ddd5e8",
      brightWhite: "#f6f0fc",
    },
  },
]

export const PRESET_IDS = new Set(PRESET_THEMES.map((t) => t.id))
export const STILL_THEME = PRESET_THEMES[0]
export const MAX_CUSTOM_THEMES = 50
export const CUSTOM_PREFIX = "custom-"

export function presetTheme(id: string | undefined): TerminalTheme | undefined {
  return PRESET_THEMES.find((t) => t.id === id)
}

export const SLOT_LABELS: Record<PaletteSlot, string> = {
  background: "Background",
  foreground: "Foreground",
  cursor: "Cursor",
  cursorAccent: "Cursor text",
  selectionBackground: "Selection",
  black: "Black",
  red: "Red",
  green: "Green",
  yellow: "Yellow",
  blue: "Blue",
  magenta: "Magenta",
  cyan: "Cyan",
  white: "White",
  brightBlack: "Bright black",
  brightRed: "Bright red",
  brightGreen: "Bright green",
  brightYellow: "Bright yellow",
  brightBlue: "Bright blue",
  brightMagenta: "Bright magenta",
  brightCyan: "Bright cyan",
  brightWhite: "Bright white",
}

// --- colour helpers -------------------------------------------------------------

/** Accept #rgb / #rrggbb (and #rrggbbaa when `alpha`). Returns lowercase or null. */
export function normalizeHex(value: unknown, alpha = false): string | null {
  if (typeof value !== "string") return null
  const v = value.trim().toLowerCase()
  let m = /^#([0-9a-f]{3})$/.exec(v)
  if (m) return "#" + m[1].split("").map((c) => c + c).join("")
  m = /^#([0-9a-f]{6})$/.exec(v)
  if (m) return "#" + m[1]
  if (alpha) {
    m = /^#([0-9a-f]{8})$/.exec(v)
    if (m) return "#" + m[1]
  }
  return null
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
  return `#${c(r)}${c(g)}${c(b)}`
}

export function relativeLuminance(hex: string): number {
  const lin = rgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/** WCAG contrast ratio (alpha channels ignored). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** Mix `a` toward `b` by `t` (0..1). */
export function mixHex(a: string, b: string, t: number): string {
  const x = rgb(a)
  const y = rgb(b)
  return toHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t)
}

export interface ContrastIssue {
  slot: PaletteSlot
  ratio: number
  min: number
}

/** Advisory only: fg/bg needs 4.5, ANSI colours and the cursor need 3. */
export function themeContrastIssues(colors: TerminalPalette): ContrastIssue[] {
  const issues: ContrastIssue[] = []
  const bg = colors.background
  const check = (slot: PaletteSlot, min: number) => {
    const ratio = contrastRatio(colors[slot], bg)
    if (ratio < min) issues.push({ slot, ratio, min })
  }
  check("foreground", 4.5)
  check("cursor", 3)
  for (const slot of ANSI_SLOTS) {
    // ANSI black deliberately equals the background in most themes.
    if (slot === "black" && contrastRatio(colors.black, bg) < 1.2) continue
    check(slot, 3)
  }
  return issues
}

// --- normalizers ----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function normalizeTheme(raw: unknown): TerminalTheme | null {
  if (!isRecord(raw)) return null
  const rawId = typeof raw.id === "string" ? raw.id.trim() : ""
  if (!rawId) return null
  const id = rawId.startsWith(CUSTOM_PREFIX) ? rawId : CUSTOM_PREFIX + rawId
  if (id.length > 80) return null
  const basedOn = typeof raw.basedOn === "string" && PRESET_IDS.has(raw.basedOn) ? raw.basedOn : undefined
  const base = presetTheme(basedOn) ?? STILL_THEME
  const src = isRecord(raw.colors) ? raw.colors : {}
  const colors = {} as TerminalPalette
  for (const slot of PALETTE_SLOTS) {
    colors[slot] = normalizeHex(src[slot], slot === "selectionBackground") ?? base.colors[slot]
  }
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : "Custom theme"
  const kind: TerminalTheme["kind"] =
    raw.kind === "light" || raw.kind === "dark" ? raw.kind : relativeLuminance(colors.background) > 0.4 ? "light" : "dark"
  const theme: TerminalTheme = { id, name, kind, colors }
  if (basedOn) theme.basedOn = basedOn
  const pf = normalizeHex(raw.previewForeground)
  if (pf) theme.previewForeground = pf
  return theme
}

export function normalizeCustomThemes(raw: unknown): TerminalTheme[] {
  if (!Array.isArray(raw)) return []
  const out: TerminalTheme[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const theme = normalizeTheme(item)
    if (!theme || seen.has(theme.id)) continue
    seen.add(theme.id)
    out.push(theme)
    if (out.length >= MAX_CUSTOM_THEMES) break
  }
  return out
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: FONT_DEFAULT,
  cursorStyle: "block",
  scrollback: 5000,
  themeId: STILL_THEME_ID,
  cursorBlink: "auto",
  minimumContrastRatio: "auto",
  screenReaderMode: false,
  visualBell: false,
}

function clampScrollback(value: unknown): number {
  // Same range as terminalScrollback() in types (duplicated: type-only imports here).
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1000, Math.min(50000, Math.trunc(value))) : 5000
}

export function normalizeTerminalPrefs(raw: unknown): TerminalPrefs {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_TERMINAL_PREFS
  const mcr = r.minimumContrastRatio
  return {
    fontSize: clampFontSize(r.fontSize),
    cursorStyle: r.cursorStyle === "underline" || r.cursorStyle === "bar" || r.cursorStyle === "block" ? r.cursorStyle : d.cursorStyle,
    scrollback: clampScrollback(r.scrollback),
    themeId: typeof r.themeId === "string" && r.themeId ? r.themeId : d.themeId,
    cursorBlink: r.cursorBlink === "on" || r.cursorBlink === "off" || r.cursorBlink === "auto" ? r.cursorBlink : d.cursorBlink,
    minimumContrastRatio: mcr === 1 || mcr === 3 || mcr === 4.5 || mcr === 7 || mcr === "auto" ? mcr : d.minimumContrastRatio,
    screenReaderMode: r.screenReaderMode === true,
    visualBell: r.visualBell === true,
  }
}

export interface SessionAppearance {
  terminalTheme?: string
  fontSize?: number
}

export function normalizeSessionAppearance(raw: unknown): SessionAppearance {
  const r = isRecord(raw) ? raw : {}
  const out: SessionAppearance = {}
  if (typeof r.terminalTheme === "string" && r.terminalTheme) out.terminalTheme = r.terminalTheme
  if (typeof r.fontSize === "number" && Number.isFinite(r.fontSize)) out.fontSize = clampFontSize(r.fontSize)
  return out
}

// --- resolution -----------------------------------------------------------------

export interface ResolvedAppearance {
  theme: TerminalTheme
  xtermTheme: ITheme
  fontSize: number
  cursorStyle: TerminalPrefs["cursorStyle"]
  cursorBlink: boolean
  scrollback: number
  minimumContrastRatio: number
  screenReaderMode: boolean
  visualBell: boolean
  previewForeground: string
  sources: { theme: "session" | "default"; fontSize: "session" | "default" }
}

export function findTheme(id: string | undefined, custom: readonly TerminalTheme[] | undefined): TerminalTheme | undefined {
  if (!id) return undefined
  return presetTheme(id) ?? custom?.find((t) => t.id === id)
}

export function buildXtermTheme(colors: TerminalPalette): ITheme {
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.cursor,
    cursorAccent: colors.cursorAccent,
    selectionBackground: colors.selectionBackground,
    // Stock bars are hidden (theme.css + CustomScrollbar); keep the
    // built-in slider/ruler permanently unpainted as a backstop.
    scrollbarSliderBackground: "rgba(0,0,0,0)",
    scrollbarSliderHoverBackground: "rgba(0,0,0,0)",
    scrollbarSliderActiveBackground: "rgba(0,0,0,0)",
    overviewRulerBorder: "#00000000",
    black: colors.black,
    red: colors.red,
    green: colors.green,
    yellow: colors.yellow,
    blue: colors.blue,
    magenta: colors.magenta,
    cyan: colors.cyan,
    white: colors.white,
    brightBlack: colors.brightBlack,
    brightRed: colors.brightRed,
    brightGreen: colors.brightGreen,
    brightYellow: colors.brightYellow,
    brightBlue: colors.brightBlue,
    brightMagenta: colors.brightMagenta,
    brightCyan: colors.brightCyan,
    brightWhite: colors.brightWhite,
  }
}

export function previewForegroundFor(theme: TerminalTheme): string {
  return theme.previewForeground ?? mixHex(theme.colors.foreground, theme.colors.background, 0.2)
}

type AppearanceSettings = Pick<AppSettings, "terminal"> & { customThemes?: readonly TerminalTheme[] }

/**
 * Theme lookup order: session override, then app default, then the built-in
 * Still preset (a deleted or unknown id can never leave a terminal unthemed).
 */
export function resolveTerminalAppearance(
  session: Partial<Pick<Session, "terminalTheme" | "fontSize">> | null | undefined,
  settings: AppearanceSettings,
  env: AppearanceEnv = DEFAULT_ENV,
): ResolvedAppearance {
  const prefs = normalizeTerminalPrefs(settings.terminal)
  const custom = settings.customThemes
  const sessionTheme = findTheme(session?.terminalTheme, custom)
  const defaultTheme = findTheme(prefs.themeId, custom)
  const theme = sessionTheme ?? defaultTheme ?? STILL_THEME
  const sessionFont = typeof session?.fontSize === "number" && Number.isFinite(session.fontSize)
  const mcr = prefs.minimumContrastRatio === "auto" ? (env.moreContrast ? 4.5 : 1) : prefs.minimumContrastRatio
  return {
    theme,
    xtermTheme: buildXtermTheme(theme.colors),
    fontSize: sessionFont ? clampFontSize(session!.fontSize) : prefs.fontSize,
    cursorStyle: prefs.cursorStyle,
    cursorBlink: prefs.cursorBlink === "on" ? true : prefs.cursorBlink === "off" ? false : !env.reducedMotion,
    scrollback: prefs.scrollback,
    minimumContrastRatio: mcr,
    screenReaderMode: prefs.screenReaderMode,
    visualBell: prefs.visualBell,
    previewForeground: previewForegroundFor(theme),
    sources: {
      theme: sessionTheme ? "session" : "default",
      fontSize: sessionFont ? "session" : "default",
    },
  }
}
