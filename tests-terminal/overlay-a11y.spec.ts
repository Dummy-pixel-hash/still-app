import { test, expect, type Page } from "@playwright/test"

const writes = (page: Page) => page.evaluate(() => (window as any).harness.writesBySession.map((w: { id: string; bytes: number[] }) => ({ id: w.id, text: new TextDecoder().decode(new Uint8Array(w.bytes)) })))
const clear = (page: Page) => page.evaluate(() => (window as any).harness.clear())
const output = (page: Page, id: string, text: string) => page.evaluate(({ id, text }) => (window as any).harness.output(id, text), { id, text })

async function open(page: Page, name = "A", id = "terminal-a") {
  await page.getByRole("button", { name: `Open Terminal ${name} on fixture.invalid`, exact: true }).click()
  await expect(page.locator(`#still-term-${id} .xterm-helper-textarea`)).toBeFocused()
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html?workspace")
})

test("host-key prompt takes focus on Reject, labels itself, and no keystroke reaches the PTY", async ({ page }) => {
  await open(page)
  await clear(page)
  await page.evaluate(() => (window as any).harness.hostKeyPrompt("terminal-a"))
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAccessibleName(/Unknown SSH host/)
  await expect(dialog).toHaveAccessibleDescription(/SHA256:fixtureFingerprint/)
  await expect(page.getByRole("button", { name: "Reject" })).toBeFocused()
  // Typing while the prompt is up goes nowhere (focus is on Reject, input is paused).
  await page.keyboard.type("hunter2")
  await page.locator("#still-term-terminal-a .xterm-helper-textarea").evaluate(el => (el as HTMLTextAreaElement).focus())
  await page.keyboard.type("secret\n")
  expect(await writes(page)).toEqual([])
  await page.getByRole("button", { name: "Reject" }).click()
  await expect(dialog).toBeHidden()
  // After the decision the terminal owns input again.
  await expect(page.locator("#still-term-terminal-a .xterm-helper-textarea")).toBeFocused()
  await page.keyboard.type("x")
  expect(await writes(page)).toEqual([{ id: "terminal-a", text: "x" }])
})

test("find bar: count, navigation, Escape closes and returns to the terminal", async ({ page }) => {
  await open(page)
  await output(page, "terminal-a", "alpha one\r\nbeta two\r\nalpha three\r\nalpha four\r\n")
  await page.keyboard.press("Control+Shift+F")
  const find = page.locator("[data-terminal-find]")
  await expect(find).toBeVisible()
  await expect(find.getByLabel("Find")).toBeFocused()
  await clear(page)
  await page.keyboard.type("alpha")
  await expect(page.getByTestId("find-status")).toHaveText(/\d of 3/)
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("find-status")).toHaveText(/\d of 3/)
  await page.getByRole("button", { name: "Next" }).click()
  await page.getByRole("button", { name: "Previous" }).click()
  await find.getByLabel("Find").fill("alphazzz")
  await expect(page.getByTestId("find-status")).toHaveText("No results")
  // Nothing typed into the find bar reached the PTY.
  expect(await writes(page)).toEqual([])
  await page.keyboard.press("Escape")
  await expect(find).toBeHidden()
  // Escape closed only the find bar; the overlay is still open and focused.
  await expect(page.locator("#still-term-terminal-a .xterm-helper-textarea")).toBeFocused()
})

test("new-output button appears after scrolling up and new output, and jumps to the end", async ({ page }) => {
  await open(page)
  await output(page, "terminal-a", Array.from({ length: 200 }, (_, i) => `line ${i}\r\n`).join(""))
  await expect(page.getByTestId("new-output")).toHaveCount(0)
  const screen = await page.locator("#still-term-terminal-a .xterm-screen").boundingBox()
  await page.mouse.move(screen!.x + 100, screen!.y + 100)
  await page.mouse.wheel(0, -600)
  await expect.poll(() => page.evaluate(() => { const b = (window as any).harness.terminal("terminal-a").buffer.active; return b.viewportY < b.baseY })).toBe(true)
  await output(page, "terminal-a", "fresh output\r\n")
  const button = page.getByTestId("new-output")
  await expect(button).toBeVisible()
  await button.click()
  await expect(button).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => { const b = (window as any).harness.terminal("terminal-a").buffer.active; return b.viewportY >= b.baseY })).toBe(true)
})

test("F6 moves to the controls pill, Escape returns to the terminal", async ({ page }) => {
  await open(page)
  // Let the auto-hide timer run out so the pill is genuinely hidden.
  const pill = page.getByRole("toolbar")
  await expect.poll(() => pill.evaluate(el => getComputedStyle(el).opacity), { timeout: 8000 }).toBe("0")
  await page.keyboard.press("F6")
  await expect(pill.getByRole("button", { name: "Shortcuts" })).toBeFocused()
  await expect.poll(() => pill.evaluate(el => getComputedStyle(el).opacity)).toBe("1")
  await page.keyboard.press("Escape")
  await expect(page.locator("#still-term-terminal-a .xterm-helper-textarea")).toBeFocused()
  // Overlay is still open: Escape on the pill did not close it.
  await expect(page.locator('[data-overlay-root="solo"]')).toBeVisible()
})

test("Ctrl+Shift+/ opens the generated shortcut help and Escape closes only it", async ({ page }) => {
  await open(page)
  await clear(page)
  await page.keyboard.press("Control+Shift+/")
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Ctrl+Shift+F")
  await expect(dialog).toContainText("F6")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-overlay-root="solo"]')).toBeVisible()
  expect(await writes(page)).toEqual([])
})

test("connection footers announce: error is an alert, connecting is a status; toggle exposes state", async ({ page }) => {
  await open(page)
  await page.evaluate(() => (window as any).harness.fail("terminal-a", "connection refused"))
  const alert = page.getByRole("alert").filter({ hasText: "connection refused" })
  await expect(alert).toBeVisible()
  await page.evaluate(() => (window as any).harness.setStatus("terminal-a", "connecting"))
  const status = page.getByRole("status").filter({ hasText: "connecting…" })
  await expect(status).toBeVisible()
  const toggle = status.getByRole("button", { name: /connecting/ })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(status.getByRole("button", { name: "Reconnect" })).toBeVisible()
})

test("visual bell flashes only when enabled", async ({ page }) => {
  await open(page)
  await output(page, "terminal-a", "\x07")
  await expect(page.getByTestId("visual-bell")).toHaveCount(0)
  await page.evaluate(() => (window as any).harness.updateTerminalPrefs({ visualBell: true }))
  await output(page, "terminal-a", "\x07")
  await expect(page.getByTestId("visual-bell")).toBeVisible()
})
