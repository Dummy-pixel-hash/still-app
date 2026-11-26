import { useEffect, useId, useMemo, useRef, useState } from "react"
import {
  ANSI_SLOTS,
  BASE_SLOTS,
  MAX_CUSTOM_THEMES,
  PRESET_THEMES,
  SLOT_LABELS,
  findTheme,
  normalizeHex,
  themeContrastIssues,
  type PaletteSlot,
  type TerminalTheme,
} from "../terminal/appearance"
import ThemePreview from "../terminal/ThemePreview"
import ThemeSwatch from "../terminal/ThemeSwatch"
import {
  createCustomTheme,
  deleteCustomTheme,
  setDefaultTheme,
  updateCustomTheme,
  useStore,
} from "../session/store"
import { buttonClass, inputClass } from "./fields"

/** Colour picker + hex field for one palette slot. Presets render read-only. */
function SlotRow({
  slot,
  value,
  readOnly,
  onCommit,
}: {
  slot: PaletteSlot
  value: string
  readOnly: boolean
  onCommit: (hex: string) => void
}) {
  const id = useId()
  const alpha = slot === "selectionBackground"
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const valid = normalizeHex(draft, alpha)
  // <input type=color> only holds #rrggbb; keep a selection's alpha byte aside.
  const rgb = value.slice(0, 7)
  const tail = value.length === 9 ? value.slice(7) : ""
  return (
    <div className="flex items-center gap-2">
      <span id={`${id}-l`} className="w-32 shrink-0 text-xs text-dim">
        {SLOT_LABELS[slot]}
      </span>
      <input
        type="color"
        aria-labelledby={`${id}-l`}
        value={rgb}
        disabled={readOnly}
        onChange={(e) => onCommit(e.target.value + tail)}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span id={`${id}-h`} className="sr-only">
        hex value
      </span>
      <input
        type="text"
        aria-labelledby={`${id}-l ${id}-h`}
        aria-invalid={valid ? undefined : true}
        value={draft}
        disabled={readOnly}
        spellCheck={false}
        maxLength={9}
        onChange={(e) => {
          setDraft(e.target.value)
          const ok = normalizeHex(e.target.value, alpha)
          if (ok) onCommit(ok)
        }}
        onBlur={() => setDraft(value)}
        className={`${inputClass} w-28 font-mono !py-1 text-xs ${valid ? "" : "!border-[#ff8080]/70"}`}
      />
    </div>
  )
}

/**
 * Presets and custom themes: swatch list, duplicate / rename / delete,
 * 21 colour slots with live preview, advisory contrast warnings.
 */
export default function ThemeEditor() {
  const store = useStore()
  const { customThemes } = store.settings
  const defaultId = store.settings.terminal.themeId
  const all = useMemo(() => [...PRESET_THEMES, ...customThemes], [customThemes])
  const [selectedId, setSelectedId] = useState(() => findTheme(defaultId, customThemes)?.id ?? "still")
  const selected: TerminalTheme = all.find((t) => t.id === selectedId) ?? all[0]
  // A deleted selection falls back to the first entry.
  useEffect(() => {
    if (!all.some((t) => t.id === selectedId)) setSelectedId(all[0].id)
  }, [all, selectedId])

  const readOnly = Boolean(selected.builtIn)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setRenaming(false)
    setConfirmDelete(false)
  }, [selectedId])
  useEffect(() => {
    if (renaming) nameRef.current?.focus()
  }, [renaming])

  const usedBy = store.sessions.filter((s) => s.terminalTheme === selected.id).length
  const issues = themeContrastIssues(selected.colors)
  const listId = useId()
  const atCap = customThemes.length >= MAX_CUSTOM_THEMES

  const duplicate = () => {
    const copy = createCustomTheme(`${selected.name} copy`, selected)
    if (copy) setSelectedId(copy.id)
  }

  const commitRename = () => {
    updateCustomTheme(selected.id, { name: nameDraft })
    setRenaming(false)
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div>
        <p id={`${listId}-label`} className="mb-2 text-xs text-dim">
          Themes
        </p>
        <ul aria-labelledby={`${listId}-label`} className="flex flex-col gap-1">
          {all.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                aria-pressed={t.id === selected.id}
                onClick={() => setSelectedId(t.id)}
                className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[13px] transition ${
                  t.id === selected.id ? "border-white/30 bg-white/[0.06] text-fg" : "border-white/10 text-dim hover:bg-white/[0.04] hover:text-fg"
                }`}
              >
                <ThemeSwatch theme={t} />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                {t.builtIn ? <span className="shrink-0 text-xs text-faint">Built-in</span> : null}
                {t.id === defaultId ? (
                  <span className="shrink-0 rounded-full border border-white/30 px-1.5 text-xs text-fg">Default</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {renaming && !readOnly ? (
            <>
              <label htmlFor={`${listId}-name`} className="text-xs text-dim">
                Theme name
              </label>
              <input
                id={`${listId}-name`}
                ref={nameRef}
                value={nameDraft}
                maxLength={40}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename()
                  if (e.key === "Escape") {
                    e.stopPropagation()
                    setRenaming(false)
                  }
                }}
                className={`${inputClass} w-56 !py-1`}
              />
              <button type="button" className={buttonClass} onClick={commitRename}>
                Save name
              </button>
              <button type="button" className={buttonClass} onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <h4 className="mr-2 font-serif text-xl text-fg">{selected.name}</h4>
              {selected.id !== defaultId ? (
                <button type="button" className={buttonClass} onClick={() => setDefaultTheme(selected.id)}>
                  Set as default
                </button>
              ) : null}
              <button type="button" className={buttonClass} onClick={duplicate} disabled={atCap}>
                Duplicate
              </button>
              {!readOnly ? (
                <>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      setNameDraft(selected.name)
                      setRenaming(true)
                    }}
                  >
                    Rename
                  </button>
                  <button type="button" className={`${buttonClass} !text-[#ff8080]`} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
        {readOnly ? (
          <p className="mt-2 text-xs text-dim">Built-in themes are read-only. Duplicate one to edit its colours.</p>
        ) : null}
        {atCap ? <p className="mt-2 text-xs text-dim">You have reached the limit of {MAX_CUSTOM_THEMES} custom themes.</p> : null}
        {confirmDelete ? (
          <div role="alertdialog" aria-labelledby={`${listId}-del`} className="mt-3 rounded-lg border border-[#ff4a4a]/40 bg-[#ff4a4a]/[0.06] p-3">
            <p id={`${listId}-del`} className="text-[13px] text-fg">
              Delete “{selected.name}”?{" "}
              {usedBy > 0
                ? `${usedBy} ${usedBy === 1 ? "session uses" : "sessions use"} it and will go back to the default theme.`
                : "No sessions use it."}
              {selected.id === defaultId ? " It is the default, so the default returns to Still." : ""}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={`${buttonClass} !bg-[#ff4a4a]/80 !text-black`}
                onClick={() => {
                  deleteCustomTheme(selected.id)
                  setConfirmDelete(false)
                }}
              >
                Delete theme
              </button>
              <button type="button" className={buttonClass} onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </div>
          </div>
        ) : null}

        <ThemePreview theme={selected} fontSize={store.settings.terminal.fontSize} cursorStyle={store.settings.terminal.cursorStyle} />

        <div role="status" aria-live="polite" data-testid="contrast-status" className="mt-3 text-xs">
          {issues.length === 0 ? (
            <p className="text-dim">Contrast looks good: text 4.5:1 or better, colours and cursor 3:1 or better.</p>
          ) : (
            <div className="rounded-lg border border-amber-300/30 bg-amber-950/30 p-2.5 text-amber-100">
              <p className="font-medium">Low contrast against the background (advisory)</p>
              <ul className="mt-1 list-disc pl-5">
                {issues.map((i) => (
                  <li key={i.slot}>
                    {SLOT_LABELS[i.slot]} is {i.ratio.toFixed(2)}:1 (needs {i.min}:1)
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-4 grid gap-x-6 gap-y-1.5 md:grid-cols-2">
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-fg">Base colours</legend>
            {BASE_SLOTS.map((slot) => (
              <SlotRow
                key={slot}
                slot={slot}
                value={selected.colors[slot]}
                readOnly={readOnly}
                onCommit={(hex) => updateCustomTheme(selected.id, { colors: { [slot]: hex } })}
              />
            ))}
          </fieldset>
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-fg">ANSI colours</legend>
            {ANSI_SLOTS.map((slot) => (
              <SlotRow
                key={slot}
                slot={slot}
                value={selected.colors[slot]}
                readOnly={readOnly}
                onCommit={(hex) => updateCustomTheme(selected.id, { colors: { [slot]: hex } })}
              />
            ))}
          </fieldset>
        </div>
      </div>
    </div>
  )
}
