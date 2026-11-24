import { test, expect, type Page } from "@playwright/test"

const open = (page: Page, name: string) => page.getByRole("button", { name: `Open Terminal ${name} on fixture.invalid`, exact: true })

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html?workspace")
  await expect(open(page, "A")).toBeVisible()
})

test("cards are a roving grid: one Tab stop, arrows move, Home/End jump", async ({ page }) => {
  // Only one card Open button is in the tab order.
  await expect(page.locator("[data-card-open][tabindex='0']")).toHaveCount(1)
  await expect(page.locator("[data-card-open][tabindex='-1']")).toHaveCount(1)
  await open(page, "A").focus()
  await page.keyboard.press("ArrowRight")
  await expect(open(page, "B")).toBeFocused()
  await expect(open(page, "B")).toHaveAttribute("tabindex", "0")
  await expect(open(page, "A")).toHaveAttribute("tabindex", "-1")
  await page.keyboard.press("Home")
  await expect(open(page, "A")).toBeFocused()
  await page.keyboard.press("End")
  await expect(open(page, "B")).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(open(page, "A")).toBeFocused()
})

test("Shift+F10 opens the card menu; arrows, Escape and Tab behave; Move later reorders", async ({ page }) => {
  await open(page, "A").focus()
  await page.keyboard.press("Shift+F10")
  const menu = page.getByRole("menu", { name: "Terminal A actions" })
  await expect(menu).toBeVisible()
  const items = menu.getByRole("menuitem")
  await expect(items.first()).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press("End")
  await expect(items.last()).toBeFocused()
  await page.keyboard.press("o") // typeahead -> Open
  await expect(menu.getByRole("menuitem", { name: "Open", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Actions for Terminal A" })).toBeFocused()
  // Tab closes it too.
  await page.keyboard.press("Enter")
  await expect(menu).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(menu).toHaveCount(0)
  // Keyboard reorder replaces the drag grip.
  await page.getByRole("button", { name: "Actions for Terminal A" }).click()
  await menu.getByRole("menuitem", { name: "Move later" }).click()
  const names = await page.locator("[data-card] h3").allTextContents()
  expect(names).toEqual(["Terminal B", "Terminal A"])
  await expect(page.getByRole("separator")).toHaveCount(0)
})

test("opening from the menu returns focus to the card's Open button on close", async ({ page }) => {
  await open(page, "B").focus()
  await page.keyboard.press("Shift+F10")
  await page.getByRole("menuitem", { name: "Open", exact: true }).click()
  await expect(page.locator("#still-term-terminal-b .xterm-helper-textarea")).toBeFocused()
  await page.keyboard.press("Control+.")
  await expect(page.locator("#still-term-terminal-b")).toHaveCount(0)
  await expect(open(page, "B")).toBeFocused()
})

test("Ctrl+K opens the palette and Enter jumps to a session; / focuses the filter", async ({ page }) => {
  await page.keyboard.press("/")
  await expect(page.getByRole("textbox", { name: "Search sessions" })).toBeFocused()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+k")
  const combo = page.getByRole("combobox", { name: "Type a command or session name" })
  await expect(combo).toBeFocused()
  await combo.fill("terminal b")
  await expect(page.getByRole("listbox", { name: "Commands" }).getByRole("option").first()).toHaveText(/Terminal B/)
  await expect(combo).toHaveAttribute("aria-activedescendant", /.+/)
  await page.keyboard.press("Enter")
  await expect(page.locator("#still-term-terminal-b .xterm-helper-textarea")).toBeFocused()
})

test("palette from inside a terminal (Ctrl+Shift+K) themes only that session", async ({ page }) => {
  await open(page, "A").click()
  await expect(page.locator("#still-term-terminal-a .xterm-helper-textarea")).toBeFocused()
  await page.keyboard.press("Control+Shift+K")
  const combo = page.getByRole("combobox", { name: "Type a command or session name" })
  await expect(combo).toBeFocused()
  await combo.fill("theme: tide")
  await page.keyboard.press("Enter")
  await expect.poll(() => page.evaluate(() => String((window as any).harness.terminal("terminal-a").options.theme.background))).toBe("#0a1319")
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem("still.m2.store.v1")!))
  expect(s.sessions.find((x: any) => x.id === "terminal-a").terminalTheme).toBe("tide")
  expect(s.sessions.find((x: any) => x.id === "terminal-b").terminalTheme).toBeUndefined()
  expect(s.settings.terminal.themeId).toBe("still")
})

test("status badge exposes text, not only a shape", async ({ page }) => {
  await expect(page.locator('[data-card] [data-status]').first()).toContainText(/Connected|Idle|Detached|Connecting/)
})
