import { test, expect, type Page } from "@playwright/test"

const output = (page: Page, id: string, text: string) => page.evaluate(({ id, text }) => (window as any).harness.output(id, text), { id, text })
const state = (page: Page, id: string) => page.evaluate(id => {
  const terminal = (window as any).harness.terminal(id)
  return { buffer: terminal.buffer.active.type, mouse: terminal.modes.mouseTrackingMode, paste: terminal.modes.bracketedPasteMode }
}, id)
const writes = (page: Page) => page.evaluate(() => (window as any).harness.writesBySession.map((write: { id: string; bytes: number[] }) => ({ id: write.id, text: new TextDecoder().decode(new Uint8Array(write.bytes)) })))
const clear = (page: Page) => page.evaluate(() => (window as any).harness.clear())

async function open(page: Page, name: string, id: string) {
  await page.getByRole("button", { name: `Open Terminal ${name} on fixture.invalid`, exact: true }).click()
  await expect(page.locator(`#still-term-${id} .xterm-helper-textarea`)).toBeFocused()
  await expect.poll(() => page.evaluate(id => (window as any).harness.terminal(id).cols, id)).toBeGreaterThan(40)
}

async function minimize(page: Page, id: string) {
  await page.keyboard.press("Control+.")
  await expect(page.locator(`#still-term-${id}`)).toHaveCount(0)
  await expect(page.locator('[data-overlay-root="solo"]')).toBeHidden()
}

async function wheel(page: Page, id: string) {
  const screen = await page.locator(`#still-term-${id} .xterm-screen`).boundingBox()
  await page.mouse.move(screen!.x + 100, screen!.y + 120)
  await page.mouse.wheel(0, -120)
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html?workspace")
})

test("minimize A, use B, reopen A: modes and wheel input remain attached to the right session", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await open(page, "A", "terminal-a")
  // Include actual agent-style cursor redraws beyond the 64KB transcript cap.
  await output(page, "terminal-a", "\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[Hagent A")
  await minimize(page, "terminal-a")
  await open(page, "B", "terminal-b")
  await output(page, "terminal-b", Array.from({ length: 200 }, (_, i) => `shell B ${i}\r\n`).join(""))
  await output(page, "terminal-a", ("\x1b[H" + "agent A output ".repeat(80) + "\x1b[K").repeat(100))
  await output(page, "terminal-a", "\x1b[?1002l\x1b[?1003h")
  await clear(page)
  await wheel(page, "terminal-b")
  await expect.poll(() => page.evaluate(() => {
    const buffer = (window as any).harness.terminal("terminal-b").buffer.active
    return buffer.viewportY < buffer.baseY
  })).toBe(true)
  expect(await writes(page)).toEqual([])
  await minimize(page, "terminal-b")

  for (let cycle = 0; cycle < 3; cycle++) {
    await open(page, "A", "terminal-a")
    expect(await state(page, "terminal-a")).toEqual({ buffer: "alternate", mouse: "any", paste: true })
    await expect(page.locator("#still-term-terminal-a .xterm")).toHaveCSS("cursor", "default")
    await clear(page)
    await wheel(page, "terminal-a")
    await expect.poll(async () => (await writes(page)).some((write: { text: string }) => /\x1b\[<64;/.test(write.text))).toBe(true)
    expect((await writes(page)).every((write: { id: string }) => write.id === "terminal-a")).toBe(true)
    await clear(page)
    await page.keyboard.type("x")
    expect(await writes(page)).toEqual([{ id: "terminal-a", text: "x" }])
    await minimize(page, "terminal-a")
  }

  // The same parser must also observe exits while hidden, rather than forcing
  // mouse/alt mode forever on every reopen.
  await output(page, "terminal-a", "\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l" + Array.from({ length: 200 }, (_, i) => `shell A ${i}\r\n`).join(""))
  await open(page, "A", "terminal-a")
  expect(await state(page, "terminal-a")).toEqual({ buffer: "normal", mouse: "none", paste: false })
  await clear(page)
  await wheel(page, "terminal-a")
  await expect.poll(() => page.evaluate(() => {
    const buffer = (window as any).harness.terminal("terminal-a").buffer.active
    return buffer.viewportY < buffer.baseY
  })).toBe(true)
  expect(await writes(page)).toEqual([])
  expect(errors).toEqual([])
})

test("first open after background output keeps modes even when the ring starts inside a control string", async ({ page }) => {
  await output(page, "terminal-a", "\x1b[?1049;1002;1006;2004h\x1b]0;" + "t".repeat(70_000))
  await open(page, "A", "terminal-a")
  await output(page, "terminal-a", "\x07\x1b[2J\x1b[Hagent ready")
  expect(await state(page, "terminal-a")).toEqual({ buffer: "alternate", mouse: "drag", paste: true })
  const firstRow = await page.evaluate(() => (window as any).harness.terminal("terminal-a").buffer.active.getLine(0).translateToString(true))
  expect(firstRow).toBe("agent ready")
  await clear(page)
  await wheel(page, "terminal-a")
  await expect.poll(async () => (await writes(page)).some((write: { text: string }) => /\x1b\[<64;/.test(write.text))).toBe(true)
})
