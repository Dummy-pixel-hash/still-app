import type { ReactNode } from "react"
import OrbSettings from "../orb/OrbSettings"
import type { OrbPublisherState } from "../orb/publisher"
import {
  CONTRAST_CHOICES,
  FONT_MAX,
  FONT_MIN,
  PRESET_THEMES,
  STILL_THEME,
  clampFontSize,
  findTheme,
  type ContrastPref,
  type CursorBlinkPref,
} from "../terminal/appearance"
import ThemePreview from "../terminal/ThemePreview"
import { useMediaPrefs } from "../terminal/useTerminalAppearance"
import { UpdateSettings, platform } from "../updates/UpdateNotice"
import { groupedShortcuts } from "../ui/shortcuts"
import { setDefaultTheme, updateSettings, updateTerminalPrefs, useStore } from "../session/store"
import type { ImageInsertStyle } from "../types"
import { Field, SettingBlock, Toggle, inputClass } from "./fields"
import SshKeys from "./SshKeys"
import ThemeEditor from "./ThemeEditor"

export type CategoryId = "general" | "terminal" | "themes" | "accessibility" | "shortcuts" | "keys" | "companion" | "updates"

export const CATEGORIES: { id: CategoryId; label: string; blurb: string }[] = [
  { id: "general", label: "General", blurb: "Session handling and image uploads." },
  { id: "terminal", label: "Terminal", blurb: "Default theme, text and cursor. Each terminal can override theme and size." },
  { id: "themes", label: "Themes", blurb: "Built-in presets and your own colour themes. Themes colour terminal surfaces and card previews only." },
  { id: "accessibility", label: "Accessibility", blurb: "Screen readers, contrast and the terminal bell." },
  { id: "shortcuts", label: "Keyboard shortcuts", blurb: "Every shortcut the app owns." },
  { id: "keys", label: "SSH keys", blurb: "Private keys live in the OS keyring only." },
  { id: "companion", label: "Companion", blurb: "The floating status orb." },
  { id: "updates", label: "Updates", blurb: "How Still updates itself." },
]

export interface SettingsCtx {
  orbRuntime: OrbPublisherState & { retry(): void }
  keyTextCache: Map<string, string>
  onKeyText: (keyId: string, text: string | null) => void
}

export interface SettingDef {
  id: string
  category: CategoryId
  label: string
  keywords: string[]
  render: (ctx: SettingsCtx) => ReactNode
}

function ConfirmRemove() {
  const { settings } = useStore()
  return (
    <SettingBlock id="confirm-remove" title="Removing sessions">
      <Toggle
        label="Confirm before removing a session"
        checked={settings.confirmRemove}
        onChange={(confirmRemove) => updateSettings({ confirmRemove })}
      />
    </SettingBlock>
  )
}

function ImageStyle() {
  const { settings } = useStore()
  return (
    <SettingBlock id="image-style" title="Images">
      <Field
        label="Insert uploaded image as"
        hint="After pasting an image, “Insert into agent” types its location into the agent’s input. Claude Code, Codex and Pi attach plain paths; OpenCode prefers @path."
      >
        {({ id, describedBy }) => (
          <select
            id={id}
            aria-describedby={describedBy}
            value={settings.imageInsertStyle ?? "path"}
            onChange={(e) => updateSettings({ imageInsertStyle: e.target.value as ImageInsertStyle })}
            className={inputClass}
          >
            <option value="path" className="bg-[#121214]">File path — Claude, Codex, Pi</option>
            <option value="at" className="bg-[#121214]">@path — OpenCode</option>
          </select>
        )}
      </Field>
    </SettingBlock>
  )
}

function DefaultTheme() {
  const { settings } = useStore()
  const theme = findTheme(settings.terminal.themeId, settings.customThemes) ?? STILL_THEME
  return (
    <SettingBlock id="default-theme" title="Default theme">
      <Field label="Theme for every terminal" hint="A terminal can override this from its card menu or the command palette.">
        {({ id, describedBy }) => (
          <select
            id={id}
            aria-describedby={describedBy}
            value={theme.id}
            onChange={(e) => setDefaultTheme(e.target.value)}
            className={inputClass}
          >
            <optgroup label="Built-in" className="bg-[#121214]">
              {PRESET_THEMES.map((t) => (
                <option key={t.id} value={t.id} className="bg-[#121214]">{t.name}</option>
              ))}
            </optgroup>
            {settings.customThemes.length > 0 ? (
              <optgroup label="Custom" className="bg-[#121214]">
                {settings.customThemes.map((t) => (
                  <option key={t.id} value={t.id} className="bg-[#121214]">{t.name}</option>
                ))}
              </optgroup>
            ) : null}
          </select>
        )}
      </Field>
    </SettingBlock>
  )
}

function FontCursor() {
  const { settings } = useStore()
  const t = settings.terminal
  return (
    <SettingBlock id="font-cursor" title="Text and cursor">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Font size" hint={`${FONT_MIN} to ${FONT_MAX} px. Zooming a terminal overrides this for that terminal only.`}>
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              type="number"
              min={FONT_MIN}
              max={FONT_MAX}
              value={t.fontSize}
              onChange={(e) => updateTerminalPrefs({ fontSize: clampFontSize(Number(e.target.value)) })}
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Cursor style">
          {({ id }) => (
            <select
              id={id}
              value={t.cursorStyle}
              onChange={(e) => updateTerminalPrefs({ cursorStyle: e.target.value as "block" | "underline" | "bar" })}
              className={inputClass}
            >
              <option value="block" className="bg-[#121214]">Block</option>
              <option value="underline" className="bg-[#121214]">Underline</option>
              <option value="bar" className="bg-[#121214]">Bar</option>
            </select>
          )}
        </Field>
        <Field label="Cursor blink">
          {({ id }) => (
            <select
              id={id}
              value={t.cursorBlink}
              onChange={(e) => updateTerminalPrefs({ cursorBlink: e.target.value as CursorBlinkPref })}
              className={inputClass}
            >
              <option value="auto" className="bg-[#121214]">Automatic (off with reduced motion)</option>
              <option value="on" className="bg-[#121214]">Always blink</option>
              <option value="off" className="bg-[#121214]">Never blink</option>
            </select>
          )}
        </Field>
      </div>
    </SettingBlock>
  )
}

function Scrollback() {
  const { settings } = useStore()
  return (
    <SettingBlock id="scrollback" title="Scrollback">
      <Field label="Scrollback lines" hint="1,000 to 50,000. Larger values use more memory per terminal.">
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            type="number"
            min={1000}
            max={50000}
            step={1000}
            value={settings.terminal.scrollback}
            onChange={(e) => updateTerminalPrefs({ scrollback: Math.min(50000, Math.max(1000, Number(e.target.value) || 5000)) })}
            className={`${inputClass} sm:max-w-[12rem]`}
          />
        )}
      </Field>
    </SettingBlock>
  )
}

function LivePreview() {
  const { settings } = useStore()
  const theme = findTheme(settings.terminal.themeId, settings.customThemes) ?? STILL_THEME
  return (
    <SettingBlock id="live-preview" title="Preview">
      <ThemePreview theme={theme} fontSize={settings.terminal.fontSize} cursorStyle={settings.terminal.cursorStyle} />
    </SettingBlock>
  )
}

function ScreenReader() {
  const { settings } = useStore()
  return (
    <SettingBlock id="screen-reader" title="Screen reader mode">
      <Toggle
        label="Screen reader mode"
        checked={settings.terminal.screenReaderMode}
        onChange={(screenReaderMode) => updateTerminalPrefs({ screenReaderMode })}
        hint="Mirrors terminal output into the page so screen readers can read it, and announces the bell. Costs extra memory on large scrollback, so it is off by default."
      />
    </SettingBlock>
  )
}

function MinimumContrast() {
  const { settings } = useStore()
  const env = useMediaPrefs()
  return (
    <SettingBlock id="min-contrast" title="Minimum contrast">
      <Field
        label="Minimum contrast ratio"
        hint={`Nudges any text colour that is too close to its background. Automatic uses ${env.moreContrast ? "4.5 because your system asks for more contrast" : "1 (no change) unless your system asks for more contrast"}.`}
      >
        {({ id, describedBy }) => (
          <select
            id={id}
            aria-describedby={describedBy}
            value={String(settings.terminal.minimumContrastRatio)}
            onChange={(e) => {
              const raw = e.target.value
              updateTerminalPrefs({ minimumContrastRatio: (raw === "auto" ? "auto" : Number(raw)) as ContrastPref })
            }}
            className={`${inputClass} sm:max-w-[16rem]`}
          >
            {CONTRAST_CHOICES.map((c) => (
              <option key={String(c)} value={String(c)} className="bg-[#121214]">
                {c === "auto" ? "Automatic" : c === 1 ? "1 — off" : `${c}:1`}
              </option>
            ))}
          </select>
        )}
      </Field>
    </SettingBlock>
  )
}

function VisualBell() {
  const { settings } = useStore()
  return (
    <SettingBlock id="visual-bell" title="Terminal bell">
      <Toggle
        label="Visual bell"
        checked={settings.terminal.visualBell}
        onChange={(visualBell) => updateTerminalPrefs({ visualBell })}
        hint="Flashes the edge of the terminal when a program rings the bell. With reduced motion it shows a steady border instead."
      />
    </SettingBlock>
  )
}

function OsPreferences() {
  const env = useMediaPrefs()
  return (
    <SettingBlock id="os-prefs" title="System preferences">
      <p className="text-[13px] text-dim">
        Still follows your operating system for these. Change them in your system settings.
      </p>
      <ul className="list-disc pl-5 text-[13px] text-dim">
        <li>Reduce motion: <strong className="font-medium text-fg">{env.reducedMotion ? "on" : "off"}</strong>. Stops animations and, with “Automatic”, cursor blinking.</li>
        <li>Increase contrast: <strong className="font-medium text-fg">{env.moreContrast ? "on" : "off"}</strong>. Raises text and border contrast, and the automatic terminal minimum contrast.</li>
      </ul>
    </SettingBlock>
  )
}

function ShortcutList() {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-[13px] text-dim">
        Inside a terminal, Ctrl+K and Ctrl+/ stay with your shell, so app shortcuts there use Ctrl+Shift or F6.
      </p>
      {groupedShortcuts().map(({ group, items }) => (
        <section key={group} aria-labelledby={`sc-${group.replace(/\W/g, "")}`}>
          <h3 id={`sc-${group.replace(/\W/g, "")}`} className="text-xs font-medium uppercase tracking-[0.14em] text-faint">{group}</h3>
          <dl className="mt-2 divide-y divide-white/[0.06]">
            {items.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-4 py-2">
                <dt className="text-[13px] text-dim">{s.label}</dt>
                <dd><kbd className="rounded-md border border-white/10 bg-black/40 px-2 py-0.5 font-mono text-xs text-fg">{s.keys}</kbd></dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

function OrbPanel({ runtime }: { runtime: SettingsCtx["orbRuntime"] }) {
  const { settings } = useStore()
  return <OrbSettings preferences={settings.orb} runtime={runtime} />
}

function UpdatesPanel() {
  return (
    <div>
      <UpdateSettings />
      {platform() ? null : (
        <p className="text-[13px] text-dim">Update controls appear in the Windows and Android apps. This build has nothing to update.</p>
      )}
    </div>
  )
}

export const SETTINGS: SettingDef[] = [
  { id: "confirm-remove", category: "general", label: "Confirm before removing a session", keywords: ["delete", "remove", "session", "confirmation", "dialog"], render: () => <ConfirmRemove /> },
  { id: "image-style", category: "general", label: "Insert uploaded image as", keywords: ["image", "paste", "upload", "path", "opencode", "claude", "agent"], render: () => <ImageStyle /> },
  { id: "default-theme", category: "terminal", label: "Default theme", keywords: ["colour", "color", "palette", "dark", "light", "theme"], render: () => <DefaultTheme /> },
  { id: "font-cursor", category: "terminal", label: "Font size and cursor", keywords: ["font", "text", "size", "zoom", "cursor", "blink", "block", "underline", "bar"], render: () => <FontCursor /> },
  { id: "scrollback", category: "terminal", label: "Scrollback lines", keywords: ["history", "buffer", "memory", "lines"], render: () => <Scrollback /> },
  { id: "live-preview", category: "terminal", label: "Live preview", keywords: ["preview", "sample"], render: () => <LivePreview /> },
  { id: "theme-editor", category: "themes", label: "Theme editor", keywords: ["theme", "colour", "color", "palette", "custom", "duplicate", "rename", "delete", "ansi", "background", "foreground", "selection", "contrast", "hex"], render: () => <ThemeEditor /> },
  { id: "screen-reader", category: "accessibility", label: "Screen reader mode", keywords: ["screen reader", "nvda", "orca", "voiceover", "accessible", "announce"], render: () => <ScreenReader /> },
  { id: "min-contrast", category: "accessibility", label: "Minimum contrast ratio", keywords: ["contrast", "legibility", "readable", "wcag", "low vision"], render: () => <MinimumContrast /> },
  { id: "visual-bell", category: "accessibility", label: "Visual bell", keywords: ["bell", "flash", "beep", "alert"], render: () => <VisualBell /> },
  { id: "os-prefs", category: "accessibility", label: "System preferences", keywords: ["reduced motion", "reduce motion", "more contrast", "operating system", "os", "animation"], render: () => <OsPreferences /> },
  { id: "shortcut-list", category: "shortcuts", label: "Keyboard shortcuts", keywords: ["keys", "keyboard", "hotkey", "ctrl", "palette", "find", "f6"], render: () => <ShortcutList /> },
  { id: "ssh-keys", category: "keys", label: "SSH keys", keywords: ["key", "private", "keyring", "identity", "ssh", "passphrase"], render: (ctx) => <SshKeys keyTextCache={ctx.keyTextCache} onKeyText={ctx.onKeyText} /> },
  { id: "orb", category: "companion", label: "Orb companion", keywords: ["orb", "companion", "status", "float", "glass", "size", "speed", "motion"], render: (ctx) => <OrbPanel runtime={ctx.orbRuntime} /> },
  { id: "updates", category: "updates", label: "App updates", keywords: ["update", "version", "download", "install", "cellular"], render: () => <UpdatesPanel /> },
]

export function settingMatches(def: SettingDef, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const cat = CATEGORIES.find((c) => c.id === def.category)?.label ?? ""
  const hay = `${def.label} ${def.keywords.join(" ")} ${cat}`.toLowerCase()
  return tokens.every((t) => hay.includes(t))
}
