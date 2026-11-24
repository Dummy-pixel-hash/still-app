import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/terminal/appearance.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
const a = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

const settings = (over = {}, custom = []) => ({ terminal: { ...a.DEFAULT_TERMINAL_PREFS, ...over }, customThemes: custom })

test("font clamp replaces the old mismatched limits", () => {
  assert.equal(a.FONT_MIN, 10)
  assert.equal(a.FONT_MAX, 24)
  assert.equal(a.FONT_DEFAULT, 14)
  assert.equal(a.clampFontSize(5), 10)
  assert.equal(a.clampFontSize(99), 24)
  assert.equal(a.clampFontSize("17"), 17)
  assert.equal(a.clampFontSize(NaN), 14)
  assert.equal(a.clampFontSize(undefined), 14)
  assert.equal(a.clampFontSize(15.6), 16)
})

test("normalizeHex accepts short, long and (selection-only) alpha forms", () => {
  assert.equal(a.normalizeHex("#ABC"), "#aabbcc")
  assert.equal(a.normalizeHex(" #08080A "), "#08080a")
  assert.equal(a.normalizeHex("#8f2a2a66"), null)
  assert.equal(a.normalizeHex("#8f2a2a66", true), "#8f2a2a66")
  for (const bad of [null, undefined, 12, {}, "red", "#12", "#gggggg", "08080a"]) assert.equal(a.normalizeHex(bad), null)
})

test("the still preset reproduces the shipped palette exactly", () => {
  const still = a.presetTheme("still")
  assert.equal(still.colors.background, "#08080a")
  assert.equal(still.colors.foreground, "#ded9dd")
  assert.equal(still.colors.cursor, "#ff5a5a")
  assert.equal(still.colors.selectionBackground, "#8f2a2a66")
  assert.equal(still.previewForeground, "#b0aab8")
  const x = a.buildXtermTheme(still.colors)
  assert.deepEqual(
    [x.black, x.brightBlack, x.red, x.brightRed, x.green, x.brightGreen, x.yellow, x.brightYellow, x.blue, x.brightBlue, x.magenta, x.brightMagenta, x.cyan, x.brightCyan, x.white, x.brightWhite],
    ["#08080a", "#777078", "#ff5a5a", "#ff7777", "#91b587", "#acd19f", "#d5aa82", "#e7bf98", "#9a96b8", "#b3afd0", "#b89ab8", "#cdb0cd", "#8eadb2", "#a5c4c9", "#d7d2d6", "#f4f0f2"],
  )
  assert.equal(x.overviewRulerBorder, "#00000000")
  assert.equal(x.scrollbarSliderBackground, "rgba(0,0,0,0)")
})

test("six presets with original names, every slot a valid colour", () => {
  assert.deepEqual(a.PRESET_THEMES.map((t) => t.id), ["still", "still-contrast", "paper", "tide", "moss", "dusk"])
  for (const t of a.PRESET_THEMES) {
    assert.ok(t.builtIn)
    for (const slot of a.PALETTE_SLOTS) assert.ok(a.normalizeHex(t.colors[slot], slot === "selectionBackground"), `${t.id}.${slot}`)
  }
  assert.equal(a.PALETTE_SLOTS.length, 21)
})

test("contrast ratio maths and the 4.17:1 case", () => {
  assert.equal(Math.round(a.contrastRatio("#000000", "#ffffff")), 21)
  assert.equal(a.contrastRatio("#777777", "#777777"), 1)
  // #7e7e7e on white is the textbook failing-AA pair (~4.17:1).
  const r = a.contrastRatio("#808080", "#ffffff")
  assert.ok(r > 3.9 && r < 4.1, String(r))
  const colors = { ...a.presetTheme("paper").colors, background: "#ffffff", foreground: "#8a8a8a" }
  const ratio = a.contrastRatio(colors.foreground, colors.background)
  assert.ok(ratio < 4.5)
  const issues = a.themeContrastIssues(colors)
  const fg = issues.find((i) => i.slot === "foreground")
  assert.ok(fg && fg.min === 4.5 && Math.abs(fg.ratio - ratio) < 1e-9)
})

test("built-in presets have no contrast issues; still-contrast clears 7:1", () => {
  for (const t of a.PRESET_THEMES) assert.deepEqual(a.themeContrastIssues(t.colors), [], t.id)
  const c = a.presetTheme("still-contrast").colors
  for (const slot of [...a.PALETTE_SLOTS].filter((s) => s !== "background" && s !== "cursorAccent" && s !== "selectionBackground")) {
    assert.ok(a.contrastRatio(c[slot], c.background) >= 7, `${slot} ${a.contrastRatio(c[slot], c.background)}`)
  }
})

test("normalizers survive garbage", () => {
  for (const junk of [null, undefined, 1, "x", [], [null, 3, "y", {}], { a: 1 }]) {
    assert.deepEqual(a.normalizeCustomThemes(junk), [])
    const p = a.normalizeTerminalPrefs(junk)
    assert.deepEqual(p, a.DEFAULT_TERMINAL_PREFS)
    assert.deepEqual(a.normalizeSessionAppearance(junk), {})
  }
  const themes = a.normalizeCustomThemes([
    { id: "x", name: "  ", colors: { background: "nope", foreground: "#fff" } },
    { id: "custom-x", name: "dup" },
    { id: "custom-y", name: "Y", kind: "light", basedOn: "paper", builtIn: true, colors: { red: "#f00" } },
  ])
  assert.equal(themes.length, 2)
  assert.equal(themes[0].id, "custom-x")
  assert.equal(themes[0].name, "Custom theme")
  assert.equal(themes[0].colors.background, "#08080a")
  assert.equal(themes[0].colors.foreground, "#ffffff")
  assert.equal(themes[1].colors.red, "#ff0000")
  assert.equal(themes[1].colors.green, a.presetTheme("paper").colors.green)
  assert.equal(themes[1].builtIn, undefined)
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }))
  assert.equal(a.normalizeCustomThemes(many).length, 50)
  assert.deepEqual(
    a.normalizeTerminalPrefs({ fontSize: 99, cursorStyle: "wat", scrollback: 1, themeId: 7, cursorBlink: "maybe", minimumContrastRatio: 2, screenReaderMode: "yes", visualBell: 1 }),
    { fontSize: 24, cursorStyle: "block", scrollback: 1000, themeId: "still", cursorBlink: "auto", minimumContrastRatio: "auto", screenReaderMode: false, visualBell: false },
  )
  assert.deepEqual(a.normalizeSessionAppearance({ terminalTheme: "", fontSize: 1 }), { fontSize: 10 })
  assert.deepEqual(a.normalizeSessionAppearance({ terminalTheme: "tide", fontSize: "big" }), { terminalTheme: "tide" })
})

test("resolution order is session, then default, then still", () => {
  const custom = a.normalizeCustomThemes([{ id: "mine", name: "Mine", colors: { background: "#101010" } }])
  const s = settings({ themeId: "tide", fontSize: 16 }, custom)
  let r = a.resolveTerminalAppearance({}, s)
  assert.equal(r.theme.id, "tide")
  assert.deepEqual(r.sources, { theme: "default", fontSize: "default" })
  assert.equal(r.fontSize, 16)
  r = a.resolveTerminalAppearance({ terminalTheme: "custom-mine", fontSize: 20 }, s)
  assert.equal(r.theme.id, "custom-mine")
  assert.equal(r.xtermTheme.background, "#101010")
  assert.deepEqual(r.sources, { theme: "session", fontSize: "session" })
  assert.equal(r.fontSize, 20)
})

test("deleted or unknown themes fall back without breaking", () => {
  const s = settings({ themeId: "custom-gone" })
  assert.equal(a.resolveTerminalAppearance({ terminalTheme: "custom-also-gone" }, s).theme.id, "still")
  const withDefault = settings({ themeId: "moss" })
  const r = a.resolveTerminalAppearance({ terminalTheme: "custom-gone" }, withDefault)
  assert.equal(r.theme.id, "moss")
  assert.equal(r.sources.theme, "default")
  assert.equal(a.resolveTerminalAppearance(null, { terminal: undefined }).theme.id, "still")
})

test("font overrides clamp and auto blink/contrast follow the OS", () => {
  assert.equal(a.resolveTerminalAppearance({ fontSize: 99 }, settings()).fontSize, 24)
  assert.equal(a.resolveTerminalAppearance({ fontSize: 2 }, settings()).fontSize, 10)
  const base = a.resolveTerminalAppearance({}, settings())
  assert.equal(base.cursorBlink, true)
  assert.equal(base.minimumContrastRatio, 1)
  const os = a.resolveTerminalAppearance({}, settings(), { reducedMotion: true, moreContrast: true })
  assert.equal(os.cursorBlink, false)
  assert.equal(os.minimumContrastRatio, 4.5)
  const forced = a.resolveTerminalAppearance({}, settings({ cursorBlink: "on", minimumContrastRatio: 3 }), { reducedMotion: true, moreContrast: true })
  assert.equal(forced.cursorBlink, true)
  assert.equal(forced.minimumContrastRatio, 3)
  assert.equal(a.resolveTerminalAppearance({}, settings({ cursorBlink: "off" })).cursorBlink, false)
})

test("preview foreground: still keeps its fixed colour, others derive from the palette", () => {
  assert.equal(a.resolveTerminalAppearance({}, settings()).previewForeground, "#b0aab8")
  const tide = a.resolveTerminalAppearance({ terminalTheme: "tide" }, settings())
  assert.notEqual(tide.previewForeground, tide.theme.colors.foreground)
  assert.ok(a.contrastRatio(tide.previewForeground, tide.theme.colors.background) >= 4.5)
})
