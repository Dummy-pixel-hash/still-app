import { test, expect, type Page } from "@playwright/test"

const TUI = "\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H"
const h = (page: Page, script: string) => page.evaluate(script)
const emittedText = (page: Page) => h(page, 'new TextDecoder().decode(new Uint8Array(harness.writes.flat()))')

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html")
  await page.waitForFunction(() => (window as any).harness?.term?.cols > 40)
  await page.locator(".xterm-helper-textarea").focus()
  await h(page, "harness.clear()")
})

test("copy uses OS bridge once in alternate screen; Ctrl+C still interrupts", async ({ page }) => {
  await page.evaluate(async prefix => { const a = (window as any).harness; await a.emit(prefix + "hello λ world"); a.term.select(0, 0, 7); a.clear() }, TUI)
  await page.keyboard.press("Control+Shift+C")
  await expect.poll(() => h(page, "harness.copies")).toEqual(["hello λ"])
  expect(await emittedText(page)).toBe("")
  await page.keyboard.press("Control+C")
  expect(await emittedText(page)).toBe("\x03")
})

test("real Shift-drag selects TUI text despite remote mouse tracking", async ({ page }) => {
  await page.evaluate(async prefix => { await (window as any).harness.emit(prefix + "TUI selection text"); }, TUI)
  const box = await page.locator(".xterm-screen").boundingBox()
  const cols = await h(page, "harness.term.cols")
  const rowHeight = box!.height / await h(page, "harness.term.rows")
  const cell = box!.width / cols
  await page.keyboard.down("Shift")
  await page.mouse.move(box!.x + 1, box!.y + rowHeight / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + cell * 13, box!.y + rowHeight / 2, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up("Shift")
  const selection = await h(page, "harness.term.getSelection()")
  expect(selection).toContain("TUI selection")
  await page.keyboard.press("Control+Shift+C")
  await expect.poll(() => h(page, "harness.copies")).toEqual([selection])
})

test("no selection and OS failure are visible, not silent or PTY output", async ({ page }) => {
  await page.keyboard.press("Control+Shift+C")
  await expect(page.getByRole("status")).toContainText("Nothing selected")
  expect(await h(page, "harness.copies.length")).toBe(0)
  await h(page, 'harness.emit("text").then(() => { harness.term.select(0,0,4); harness.rejectCopy = true })')
  await page.keyboard.press("Control+Shift+C")
  await expect(page.getByRole("status")).toContainText("Copy failed")
  expect(await emittedText(page)).toBe("")
})

test("TUI OSC52 is staged until explicit copy; read/query never reads clipboard", async ({ page }) => {
  await h(page, 'harness.emit("\\x1b]52;c;" + btoa("TUI buffer") + "\\x07")')
  expect(await h(page, "harness.copies.length")).toBe(0)
  await expect(page.getByRole("status")).toContainText("TUI selection ready")
  await h(page, 'harness.emit("\\x1b]52;c;?\\x07")')
  expect(await h(page, "harness.reads")).toBe(0)
  expect(await emittedText(page)).toBe("")
  await page.keyboard.press("Control+Shift+C")
  await expect.poll(() => h(page, "harness.copies")).toEqual(["TUI buffer"])
  await page.keyboard.press("Control+Shift+C")
  expect(await h(page, "harness.copies.length")).toBe(1)
})

// Real tmux 3.5a emits an EMPTY selection name: ESC ] 52 ; ; <base64> ST.
test("tmux wire form 52;;selection is accepted, oversized/malformed payloads are not", async ({ page }) => {
  await h(page, 'harness.emit("\\x1b]52;;" + btoa("tmux line 169") + "\\x1b\\\\")')
  await expect(page.getByRole("status")).toContainText("TUI selection ready")
  await page.keyboard.press("Control+Shift+C")
  await expect.poll(() => h(page, "harness.copies")).toEqual(["tmux line 169"])
  for (const bad of ["\x1b]52;;!!!\x07", "\x1b]52;;" + "A".repeat(1_400_000) + "\x07", "\x1b]52;p;c2Vjb25kYXJ5\x07"]) {
    await page.evaluate(text => (window as any).harness.emit(text), bad)
  }
  expect(await h(page, "harness.reads")).toBe(0)
  await page.keyboard.press("Control+Shift+C")
  expect(await h(page, "harness.copies.length")).toBe(1)
})

test("local selection wins over remote copy, reconnect/replay cannot restore stale copy", async ({ page }) => {
  await h(page, 'harness.emit("local\\x1b]52;c;" + btoa("remote") + "\\x07").then(() => harness.term.select(0,0,5))')
  await page.keyboard.press("Control+Shift+C")
  await expect.poll(() => h(page, "harness.copies")).toEqual(["local"])
  await h(page, 'harness.term.clearSelection(); harness.emit("\\x1b]52;c;" + btoa("stale") + "\\x07")')
  await h(page, "harness.reconnect()")
  await page.keyboard.press("Control+Shift+C")
  expect(await h(page, "harness.copies.length")).toBe(1)
  await h(page, "harness.remount()")
  await page.waitForTimeout(150)
  await page.locator(".xterm-helper-textarea").focus()
  await page.keyboard.press("Control+Shift+C")
  expect(await h(page, "harness.copies.length")).toBe(1)
})

test("Ctrl+Shift+V pastes once, uses bracketed mode only when enabled", async ({ page }) => {
  await h(page, 'harness.emit("\\x1b[?2004h")')
  await page.keyboard.press("Control+Shift+V")
  await expect.poll(() => emittedText(page)).toBe("\x1b[200~pasted λ\rsecond line\x1b[201~")
  expect(await h(page, "harness.reads")).toBe(1)
  expect(await h(page, "harness.writes.length")).toBe(1)
  await h(page, 'harness.clear(); harness.pasteText="one line"; harness.emit("\\x1b[?2004l")')
  await page.keyboard.press("Control+Shift+V")
  await expect.poll(() => emittedText(page)).toBe("one line")
})

test("native context-menu paste remains single and bracketed", async ({ page }) => {
  await h(page, 'harness.emit("\\x1b[?2004h")')
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData("text/plain", "one\ntwo")
    document.querySelector(".xterm-helper-textarea")!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }))
  })
  await expect.poll(() => emittedText(page)).toBe("\x1b[200~one\rtwo\x1b[201~")
  expect(await h(page, "harness.writes.length")).toBe(1)
})

for (const change of ["focus", "session", "unmount"]) {
  test(`pending clipboard read cannot paste after ${change} changes`, async ({ page }) => {
    await h(page, "harness.deferPaste = true")
    await page.keyboard.press("Control+Shift+V")
    await expect.poll(() => h(page, "harness.reads")).toBe(1)
    if (change === "focus") await page.locator("#other").focus()
    if (change === "session") await h(page, "harness.reconnect()")
    if (change === "unmount") await h(page, "harness.unmount()")
    await h(page, 'harness.resolvePaste("must not enter")')
    await page.waitForTimeout(80)
    expect(await emittedText(page)).toBe("")
  })
}

test("touchpad preserves magnitude and emits one IPC batch rather than one call per report", async ({ page }) => {
  const baseline = await h(page, "harness.baselineWheel()")
  expect(baseline).toBe(1) // Reproduces upstream xterm 6 magnitude loss.
  await page.evaluate(async prefix => { const a=(window as any).harness; await a.emit(prefix); a.clear() }, TUI)
  await page.evaluate(() => {
    const a=(window as any).harness
    const rect=a.term.element.querySelector(".xterm-screen").getBoundingClientRect()
    a.term.element.dispatchEvent(new WheelEvent("wheel", { bubbles:true, cancelable:true, deltaMode:0, deltaY:rect.height/a.term.rows * 6 + 0.01, clientX:rect.x+20, clientY:rect.y+20 }))
  })
  const text = await emittedText(page)
  expect(text.match(/\x1b\[<65;/g)?.length).toBe(6)
  expect(await h(page, "harness.writes.length")).toBe(1)
})

test("normal buffer scroll stays local and alt no-mouse arrow modes are preserved", async ({ page }) => {
  await h(page, 'harness.emit(Array.from({length:200},(_,i)=>"line " + i + "\\r\\n").join(""))')
  const screen = await page.locator(".xterm-screen").boundingBox()
  await page.mouse.move(screen!.x + 100, screen!.y + 100)
  await page.mouse.wheel(0, -300)
  await expect.poll(() => h(page, "harness.term.buffer.active.viewportY < harness.term.buffer.active.baseY")).toBe(true)
  expect(await emittedText(page)).toBe("")
  await h(page, 'harness.emit("\\x1b[?1049h\\x1b[?1h"); harness.clear()')
  await page.evaluate(() => {
    const a=(window as any).harness, rect=a.term.element.querySelector(".xterm-screen").getBoundingClientRect()
    a.term.element.dispatchEvent(new WheelEvent("wheel", { bubbles:true, cancelable:true, deltaMode:1, deltaY:-3, clientX:rect.x+20, clientY:rect.y+20 }))
  })
  expect(await emittedText(page)).toBe("\x1bOA".repeat(3))
})

test("zoom focused in terminal refits and notifies native dimensions without reopening", async ({ page }) => {
  const before = await h(page, "({rows:harness.term.rows, cols:harness.term.cols})")
  await page.keyboard.press("Control+-")
  await expect.poll(() => h(page, "harness.term.options.fontSize")).toBe(13)
  await expect.poll(() => h(page, "harness.term.rows")).toBeGreaterThan(before.rows)
  await expect.poll(() => h(page, "harness.resizes.at(-1).rows === harness.term.rows")).toBe(true)
  expect(await emittedText(page)).toBe("")
  await page.keyboard.press("Control+.")
  expect(await h(page, "harness.closes")).toBe(1)
})

test("browser fallback handles unavailable clipboard API and restores focus", async ({ page }) => {
  const result = await page.evaluate(async () => {
    Object.defineProperty(navigator, "clipboard", { configurable:true, value:undefined })
    const focused=document.activeElement
    let copied=""
    document.execCommand = () => { copied=(document.activeElement as HTMLTextAreaElement).value; return true }
    await (window as any).harness.browserCopy("fallback λ")
    return {copied, restored:document.activeElement===focused, leftovers:document.querySelectorAll('textarea[aria-hidden="true"]').length}
  })
  expect(result).toEqual({copied:"fallback λ",restored:true,leftovers:0})
})

test("native bridge uses the narrowly permitted clipboard plugin commands", async ({ page }) => {
  const calls = await page.evaluate(async () => {
    const seen: string[] = []
    ;(window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => { seen.push(cmd); return cmd.endsWith("read_text") ? "native λ" : undefined },
    }
    await (window as any).harness.tauriBridge.clipboardWriteText("native λ")
    const text = await (window as any).harness.tauriBridge.clipboardReadText()
    return {seen, text}
  })
  expect(calls).toEqual({seen:["plugin:clipboard-manager|write_text", "plugin:clipboard-manager|read_text"], text:"native λ"})
})

test("browser fallback reports failure and restores focus when every copy path is denied", async ({ page }) => {
  const result = await page.evaluate(async () => {
    Object.defineProperty(navigator, "clipboard", { configurable:true, value:{writeText:async()=>{throw new Error("denied")}} })
    document.execCommand = () => false
    const before=document.activeElement
    try { await (window as any).harness.browserCopy("text"); return {rejected:false, restored:false} }
    catch { return {rejected:true, restored:document.activeElement===before} }
  })
  expect(result).toEqual({rejected:true,restored:true})
})

test("pinch and horizontal gestures do not become remote wheel reports", async ({ page }) => {
  await page.evaluate(async prefix => { const a=(window as any).harness; await a.emit(prefix); a.clear() }, TUI)
  await page.evaluate(() => {
    const a=(window as any).harness, rect=a.term.element.querySelector(".xterm-screen").getBoundingClientRect()
    // The normalizer leaves modifier gestures to the native handler rather than
    // expanding a pinch into a burst. Horizontal-only input produces no reports.
    a.term.element.dispatchEvent(new WheelEvent("wheel", { bubbles:true, cancelable:true, deltaMode:0, deltaX:100, deltaY:0, clientX:rect.x+20, clientY:rect.y+20 }))
  })
  expect(await emittedText(page)).toBe("")
})
