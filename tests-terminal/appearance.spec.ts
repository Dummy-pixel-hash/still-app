import { test, expect, type Page } from "@playwright/test"

const bgOf = (page: Page, id: string) => page.evaluate(id => String((window as any).harness.terminal(id).options.theme.background), id)
const store = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("still.m2.store.v1")!))

async function open(page: Page, name: string, id: string) {
  await page.getByRole("button", { name: `Open Terminal ${name} on fixture.invalid`, exact: true }).click()
  await expect(page.locator(`#still-term-${id} .xterm-helper-textarea`)).toBeFocused()
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html?workspace")
})

test("theme switch with the overlay open keeps the same xterm instance and recolours it", async ({ page }) => {
  await open(page, "A", "terminal-a")
  expect(await bgOf(page, "terminal-a")).toBe("#08080a")
  await page.evaluate(() => {
    const t = (window as any).harness.terminal("terminal-a")
    ;(window as any).__same = t
  })
  await page.evaluate(() => (window as any).harness.setDefaultTheme("paper"))
  await expect.poll(() => bgOf(page, "terminal-a")).toBe("#f6f3ee")
  expect(await page.evaluate(() => (window as any).harness.terminal("terminal-a") === (window as any).__same)).toBe(true)
  // The overlay surface and xterm viewport follow the theme variable too.
  await expect(page.locator('[data-overlay-root="solo"]')).toHaveCSS("background-color", "rgb(246, 243, 238)")
  await expect(page.locator("#still-term-terminal-a .xterm-viewport")).toHaveCSS("background-color", "rgb(246, 243, 238)")
  // A per-session override beats the default, and clearing it falls back.
  await page.evaluate(() => (window as any).harness.setSessionAppearance("terminal-a", { terminalTheme: "tide" }))
  await expect.poll(() => bgOf(page, "terminal-a")).toBe("#0a1319")
  await page.evaluate(() => (window as any).harness.setSessionAppearance("terminal-a", { terminalTheme: undefined }))
  await expect.poll(() => bgOf(page, "terminal-a")).toBe("#f6f3ee")
  expect(await page.evaluate(() => (window as any).harness.terminal("terminal-a") === (window as any).__same)).toBe(true)
})

test("cards recolour with the default theme and a session override", async ({ page }) => {
  const wells = page.locator("[data-card] .card-preview-body").locator("xpath=..")
  await expect(wells.first()).toHaveCSS("background-color", "rgb(8, 8, 10)")
  await page.evaluate(() => (window as any).harness.setDefaultTheme("moss"))
  await expect(wells.first()).toHaveCSS("background-color", "rgb(12, 19, 13)")
  await page.evaluate(() => (window as any).harness.setSessionAppearance("terminal-b", { terminalTheme: "dusk" }))
  await expect(wells.nth(0)).toHaveCSS("background-color", "rgb(12, 19, 13)")
  await expect(wells.nth(1)).toHaveCSS("background-color", "rgb(19, 15, 27)")
})

test("zoom is per session: it sets session.fontSize, leaves the global value, and reports it", async ({ page }) => {
  await open(page, "A", "terminal-a")
  const before = (await store(page)).sessions.find((x: any) => x.id === "terminal-a").updatedAt
  await page.keyboard.press("Control+=")
  await expect(page.getByTestId("zoom-status")).toHaveText("Font 15px")
  await expect.poll(() => page.evaluate(() => (window as any).harness.terminal("terminal-a").options.fontSize)).toBe(15)
  let s = await store(page)
  expect(s.sessions.find((x: any) => x.id === "terminal-a").fontSize).toBe(15)
  expect(s.sessions.find((x: any) => x.id === "terminal-b").fontSize).toBeUndefined()
  expect(s.settings.terminal.fontSize).toBe(14)
  // Zooming must not remount the surface (it must not bump updatedAt).
  expect(s.sessions.find((x: any) => x.id === "terminal-a").updatedAt).toBe(before)
  await page.keyboard.press("Control+0")
  await expect(page.getByTestId("zoom-status")).toContainText("Font 14px")
  await expect.poll(() => page.evaluate(() => (window as any).harness.terminal("terminal-a").options.fontSize)).toBe(14)
  s = await store(page)
  expect(s.sessions.find((x: any) => x.id === "terminal-a").fontSize).toBeUndefined()
})
